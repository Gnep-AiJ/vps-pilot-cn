#!/usr/bin/env python3
import argparse
import json
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
MAX_JSON_BODY = 4096
VULTR_API_BASE = "https://api.vultr.com/v2"
API_SESSION_TTL = 30 * 60

API_SESSIONS = {}
JOBS = {}
LOCK = threading.Lock()


class VpsPilotHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/provisioning/"):
            self.get_provisioning(path.rsplit("/", 1)[-1])
            return
        super().do_GET()

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/provisioning/"):
            self.delete_provisioning(path.rsplit("/", 1)[-1])
            return
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/vultr/validate":
            self.validate_vultr_api()
            return
        if path == "/api/provisioning":
            self.start_provisioning()
            return
        self.send_error(404)

    def validate_vultr_api(self):
        payload = self.read_json_body()
        if payload is None:
            return

        api_key = str(payload.get("api_key", "")).strip()
        if len(api_key) < 20:
            self.respond_json({"ok": False, "error": "API Key 看起来太短，请检查后重试。"}, 400)
            return
        try:
            api_key.encode("ascii")
        except UnicodeEncodeError:
            self.respond_json({"ok": False, "error": "API Key 只能包含英文字符，请重新复制。"}, 400)
            return

        token = uuid.uuid4().hex
        with LOCK:
            purge_expired_api_sessions()
            API_SESSIONS[token] = {
                "api_key": api_key,
                "expires_at": time.time() + API_SESSION_TTL,
            }
        self.respond_json({"ok": True, "api_session": token})

    def start_provisioning(self):
        payload = self.read_json_body()
        if payload is None:
            return

        api_session = str(payload.get("api_session", "")).strip()
        region = str(payload.get("region", "")).strip()
        plan = str(payload.get("plan", "")).strip()
        if not api_session or not region or not plan:
            self.respond_json({"ok": False, "error": "创建参数不完整。"}, 400)
            return

        api_key = take_api_session(api_session)
        if not api_key:
            self.respond_json({"ok": False, "error": "API 验证已过期，请重新验证。"}, 401)
            return

        job_id = uuid.uuid4().hex
        with LOCK:
            JOBS[job_id] = {
                "id": job_id,
                "status": "queued",
                "message": "正在排队创建服务器",
                "error": "",
                "server": None,
                "api_key": api_key,
                "instance_id": "",
                "created_at": time.time(),
            }

        thread = threading.Thread(
            target=provision_instance,
            args=(job_id, api_key, region, plan),
            daemon=True,
        )
        thread.start()
        self.respond_json({"ok": True, "provisioning_id": job_id})

    def get_provisioning(self, job_id):
        with LOCK:
            job = JOBS.get(job_id)
            if not job:
                self.respond_json({"ok": False, "error": "创建任务不存在。"}, 404)
                return
            self.respond_json(
                {
                    "ok": True,
                    "status": job["status"],
                    "message": job["message"],
                    "error": job["error"],
                    "billing_required": job.get("billing_required", False),
                    "server": job["server"],
                }
            )

    def delete_provisioning(self, job_id):
        with LOCK:
            job = JOBS.get(job_id)
            if not job:
                self.respond_json({"ok": False, "error": "服务器记录不存在。"}, 404)
                return
            api_key = job.get("api_key", "")
            instance_id = job.get("instance_id", "")

        if not api_key or not instance_id:
            self.respond_json({"ok": False, "error": "删除信息已过期，请到 Vultr 控制台删除。"}, 409)
            return

        try:
            vultr_request(api_key, "DELETE", f"/instances/{instance_id}")
        except VultrApiError as error:
            self.respond_json(
                {"ok": False, "error": error.user_message, "billing_required": error.billing_required},
                error.http_status,
            )
            return

        update_job(job_id, "deleted", "服务器已删除")
        with LOCK:
            job = JOBS.get(job_id)
            if job:
                job["api_key"] = ""
                job["server"] = None
        self.respond_json({"ok": True})

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.respond_json({"ok": False, "error": "请求内容无效。"}, 400)
            return None

        if length <= 0 or length > MAX_JSON_BODY:
            self.respond_json({"ok": False, "error": "请求内容无效。"}, 400)
            return None

        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.respond_json({"ok": False, "error": "请求内容无效。"}, 400)
            return None

    def respond_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def provision_instance(job_id, api_key, region, plan):
    instance_id = ""
    ssh_password = ""
    try:
        update_job(job_id, "creating", "正在选择 Ubuntu LTS 镜像")
        os_id = find_ubuntu_lts_os_id(api_key)

        update_job(job_id, "creating", "正在调用 Vultr 创建服务器")
        response = vultr_request(
            api_key,
            "POST",
            "/instances",
            {
                "region": region,
                "plan": plan,
                "os_id": os_id,
                "label": f"vpspilot-{job_id[:8]}",
                "backups": "disabled",
            },
        )
        instance = response.get("instance", {})
        instance_id = instance.get("id", "")
        ssh_password = instance.get("default_password", "") or ""
        if not instance_id:
            raise VultrApiError("Vultr 没有返回实例 ID。", 502)
        set_job_instance(job_id, instance_id)

        for _ in range(120):
            update_job(job_id, "booting", "正在等待服务器启动")
            data = vultr_request(api_key, "GET", f"/instances/{instance_id}")
            instance = data.get("instance", {})
            if not ssh_password:
                ssh_password = instance.get("default_password", "") or ""

            main_ip = instance.get("main_ip", "")
            status = instance.get("status", "")
            power_status = instance.get("power_status", "")
            server_status = instance.get("server_status", "")
            if main_ip and status == "active" and power_status == "running":
                update_job(
                    job_id,
                    "running",
                    "服务器已创建",
                    server={
                        "instance_id": instance_id,
                        "ip_address": main_ip,
                        "ssh_username": "root",
                        "ssh_password": ssh_password,
                        "status": server_status or status,
                    },
                )
                return
            time.sleep(5)

        raise VultrApiError("服务器创建超时，请到 Vultr 控制台查看实例状态。", 504)
    except VultrApiError as error:
        update_job(job_id, "failed", "创建失败", error=error.user_message, billing_required=error.billing_required)
    except Exception:
        update_job(job_id, "failed", "创建失败", error="创建失败，请稍后重试。")
    finally:
        api_key = ""


def find_recent_account_instance(api_key):
    data = vultr_request(api_key, "GET", "/instances?per_page=100")
    instances = data.get("instances", [])
    instances = [instance for instance in instances if instance.get("id")]
    if not instances:
        return None

    instances.sort(key=lambda instance: instance.get("date_created", ""), reverse=True)
    instance = instances[0]
    instance_id = instance.get("id", "")
    detail = vultr_request(api_key, "GET", f"/instances/{instance_id}").get("instance", {})
    instance = {**instance, **detail}
    return {
        "instance_id": instance_id,
        "ip_address": instance.get("main_ip", "") or "未返回",
        "ssh_username": "root",
        "ssh_password": instance.get("default_password", "") or "Vultr 未返回密码",
        "status": instance.get("server_status") or instance.get("status") or "运行中",
        "label": instance.get("label", "") or instance.get("hostname", "") or "Vultr Server",
        "plan": instance.get("plan", ""),
        "region": instance.get("region", ""),
    }


def find_ubuntu_lts_os_id(api_key):
    data = vultr_request(api_key, "GET", "/os")
    systems = data.get("os", [])
    preferred = [
        "Ubuntu 24.04 LTS x64",
        "Ubuntu 22.04 LTS x64",
        "Ubuntu 20.04 LTS x64",
    ]
    for name in preferred:
        for system in systems:
            if system.get("name") == name and system.get("id"):
                return system["id"]
    for system in systems:
        name = system.get("name", "")
        if "Ubuntu" in name and "LTS" in name and "x64" in name and system.get("id"):
            return system["id"]
    raise VultrApiError("没有找到可用的 Ubuntu LTS 镜像。", 502)


def vultr_request(api_key, method, path, payload=None):
    data = None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User" + "-" + "A" + "gent": "VPS-Pilot/0.1",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(f"{VULTR_API_BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            if not body.strip():
                return {}
            return json.loads(body)
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise VultrApiError(vultr_error_message(error.code, body), error.code) from error
    except TimeoutError as error:
        raise VultrApiError("Vultr 请求超时，请稍后重试。", 504) from error
    except URLError as error:
        raise VultrApiError("无法连接 Vultr，请稍后重试。", 502) from error
    except json.JSONDecodeError as error:
        raise VultrApiError("Vultr 返回内容无法解析。", 502) from error


def update_job(job_id, status, message, error="", server=None, billing_required=False):
    with LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["status"] = status
        job["message"] = message
        job["error"] = error
        job["billing_required"] = billing_required
        if server is not None:
            job["server"] = server


def set_job_instance(job_id, instance_id):
    with LOCK:
        job = JOBS.get(job_id)
        if job:
            job["instance_id"] = instance_id


def take_api_session(token):
    with LOCK:
        purge_expired_api_sessions()
        session = API_SESSIONS.pop(token, None)
        if not session:
            return ""
        return session["api_key"]


def purge_expired_api_sessions():
    now = time.time()
    expired = [token for token, session in API_SESSIONS.items() if session["expires_at"] < now]
    for token in expired:
        API_SESSIONS.pop(token, None)


def vultr_error_message(status_code, body=""):
    body_lower = body.lower()
    if any(keyword in body_lower for keyword in ("balance", "billing", "payment", "funded", "funds", "credit")):
        return "Vultr 余额不足或账户未完成付款设置，请先充值后重试。"
    if status_code in (401, 403):
        return "API Key 无效或权限不足，请重新复制。"
    if status_code == 429:
        return "Vultr 请求过于频繁，请稍后重试。"
    if "location" in body_lower or "capacity" in body_lower or "sold out" in body_lower:
        return "当前地区暂时不可用，请换一个地区。"
    return "API 无法完成请求，请检查 Vultr 账户状态后重试。"


class VultrApiError(Exception):
    def __init__(self, user_message, status_code=502):
        super().__init__(user_message)
        self.user_message = user_message
        self.http_status = status_code if 400 <= int(status_code) <= 599 else 502
        self.billing_required = "余额不足" in user_message or "付款" in user_message


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8791, type=int)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), VpsPilotHandler)
    print(f"Serving {ROOT} on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
