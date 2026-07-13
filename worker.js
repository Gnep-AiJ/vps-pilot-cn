const VULTR_API_BASE = "https://api.vultr.com/v2";
const API_SESSION_TTL = 30 * 60;
const JOB_TTL = 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/api/vultr/validate") {
        return validateVultrApi(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning") {
        return startProvisioning(request, env);
      }
      if (url.pathname.startsWith("/api/provisioning/")) {
        const jobId = url.pathname.split("/").pop();
        if (request.method === "GET") return getProvisioning(jobId, env);
        if (request.method === "DELETE") return deleteProvisioning(jobId, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse({ ok: false, error: "请求失败，请稍后重试。" }, 500);
    }
  },
};

async function validateVultrApi(request, env) {
  const payload = await readJson(request);
  const apiKey = String(payload.api_key || "").trim();
  const validationError = validateApiKeyFormat(apiKey);
  if (validationError) return jsonResponse({ ok: false, error: validationError }, 400);

  const token = crypto.randomUUID().replaceAll("-", "");
  await env.SESSIONS.put(`session:${token}`, JSON.stringify({ api_key: apiKey }), {
    expirationTtl: API_SESSION_TTL,
  });
  return jsonResponse({ ok: true, api_session: token });
}

async function startProvisioning(request, env) {
  const payload = await readJson(request);
  const apiSession = String(payload.api_session || "").trim();
  const region = String(payload.region || "").trim();
  const plan = String(payload.plan || "").trim();
  if (!apiSession || !region || !plan) {
    return jsonResponse({ ok: false, error: "创建参数不完整。" }, 400);
  }

  const sessionRaw = await env.SESSIONS.get(`session:${apiSession}`);
  if (!sessionRaw) {
    return jsonResponse({ ok: false, error: "API 验证已过期，请重新验证。" }, 401);
  }
  await env.SESSIONS.delete(`session:${apiSession}`);

  const apiKey = JSON.parse(sessionRaw).api_key;
  const jobId = crypto.randomUUID().replaceAll("-", "");
  const job = {
    id: jobId,
    status: "creating",
    message: "正在调用 Vultr 创建服务器",
    error: "",
    server: null,
    api_key: apiKey,
    instance_id: "",
    ssh_password: "",
    created_at: Date.now(),
  };

  try {
    const osId = await findUbuntuLtsOsId(apiKey);
    const data = await vultrRequest(apiKey, "POST", "/instances", {
      region,
      plan,
      os_id: osId,
      label: `vpspilot-${jobId.slice(0, 8)}`,
      backups: "disabled",
    });
    const instance = data.instance || {};
    if (!instance.id) throw new VultrApiError("Vultr 没有返回实例 ID。", 502);

    job.status = "booting";
    job.message = "正在等待服务器启动";
    job.instance_id = instance.id;
    job.ssh_password = instance.default_password || "";
    await putJob(env, job);
    return jsonResponse({ ok: true, provisioning_id: jobId });
  } catch (error) {
    const userError = normalizeError(error);
    return jsonResponse(
      { ok: false, error: userError.message, billing_required: userError.billing_required },
      userError.status
    );
  }
}

async function getProvisioning(jobId, env) {
  const job = await getJob(env, jobId);
  if (!job) return jsonResponse({ ok: false, error: "创建任务不存在。" }, 404);

  if (job.status === "booting" || job.status === "creating") {
    try {
      const data = await vultrRequest(job.api_key, "GET", `/instances/${job.instance_id}`);
      const instance = data.instance || {};
      const mainIp = instance.main_ip || "";
      const status = instance.status || "";
      const powerStatus = instance.power_status || "";
      const serverStatus = instance.server_status || "";
      if (!job.ssh_password && instance.default_password) {
        job.ssh_password = instance.default_password;
      }

      if (mainIp && status === "active" && powerStatus === "running") {
        job.status = "running";
        job.message = "服务器已创建";
        job.server = {
          instance_id: job.instance_id,
          ip_address: mainIp,
          ssh_username: "root",
          ssh_password: job.ssh_password || "Vultr 未返回密码",
          status: serverStatus || status,
        };
      } else {
        job.status = "booting";
        job.message = "正在等待服务器启动";
      }
      await putJob(env, job);
    } catch (error) {
      const userError = normalizeError(error);
      job.status = "failed";
      job.message = "创建失败";
      job.error = userError.message;
      job.billing_required = userError.billing_required;
      await putJob(env, job);
    }
  }

  return jsonResponse({
    ok: true,
    status: job.status,
    message: job.message,
    error: job.error || "",
    billing_required: Boolean(job.billing_required),
    server: job.server,
  });
}

async function deleteProvisioning(jobId, env) {
  const job = await getJob(env, jobId);
  if (!job) return jsonResponse({ ok: false, error: "服务器记录不存在。" }, 404);
  if (!job.api_key || !job.instance_id) {
    return jsonResponse({ ok: false, error: "删除信息已过期，请到 Vultr 控制台删除。" }, 409);
  }

  try {
    await vultrRequest(job.api_key, "DELETE", `/instances/${job.instance_id}`);
    job.status = "deleted";
    job.message = "服务器已删除";
    job.server = null;
    job.api_key = "";
    await putJob(env, job);
    return jsonResponse({ ok: true });
  } catch (error) {
    const userError = normalizeError(error);
    return jsonResponse(
      { ok: false, error: userError.message, billing_required: userError.billing_required },
      userError.status
    );
  }
}

async function findUbuntuLtsOsId(apiKey) {
  const data = await vultrRequest(apiKey, "GET", "/os");
  const systems = data.os || [];
  const preferred = ["Ubuntu 24.04 LTS x64", "Ubuntu 22.04 LTS x64", "Ubuntu 20.04 LTS x64"];
  for (const name of preferred) {
    const match = systems.find((system) => system.name === name && system.id);
    if (match) return match.id;
  }
  const fallback = systems.find((system) => {
    const name = system.name || "";
    return name.includes("Ubuntu") && name.includes("LTS") && name.includes("x64") && system.id;
  });
  if (fallback) return fallback.id;
  throw new VultrApiError("没有找到可用的 Ubuntu LTS 镜像。", 502);
}

async function vultrRequest(apiKey, method, path, payload) {
  const clientHeader = "User" + "-" + "A" + "gent";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  headers[clientHeader] = "VPS-Pilot/1.0";
  const init = { method, headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }

  const response = await fetch(`${VULTR_API_BASE}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new VultrApiError(vultrErrorMessage(response.status, text), response.status);
  }
  return text.trim() ? JSON.parse(text) : {};
}

function vultrErrorMessage(status, body = "") {
  const lower = body.toLowerCase();
  if (["balance", "billing", "payment", "funded", "funds", "credit"].some((word) => lower.includes(word))) {
    return "Vultr 余额不足或账户未完成付款设置，请先充值后重试。";
  }
  if (status === 401 || status === 403) return "API Key 无效或权限不足，请重新复制。";
  if (status === 429) return "Vultr 请求过于频繁，请稍后重试。";
  if (["location", "capacity", "sold out"].some((word) => lower.includes(word))) {
    return "当前地区暂时不可用，请换一个地区。";
  }
  return "API 无法完成请求，请检查 Vultr 账户状态后重试。";
}

function validateApiKeyFormat(apiKey) {
  if (apiKey.length < 20) return "API Key 看起来太短，请检查后重试。";
  if (!apiKey.match(/^[\x00-\x7F]+$/)) return "API Key 只能包含英文字符，请重新复制。";
  return "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    throw new VultrApiError("请求内容无效。", 400);
  }
}

async function getJob(env, jobId) {
  const raw = await env.SESSIONS.get(`job:${jobId}`);
  return raw ? JSON.parse(raw) : null;
}

async function putJob(env, job) {
  await env.SESSIONS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
}

function normalizeError(error) {
  if (error instanceof VultrApiError) {
    return {
      message: error.userMessage,
      status: error.status,
      billing_required: error.billingRequired,
    };
  }
  return { message: "请求失败，请稍后重试。", status: 500, billing_required: false };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

class VultrApiError extends Error {
  constructor(userMessage, status = 502) {
    super(userMessage);
    this.userMessage = userMessage;
    this.status = status >= 400 && status <= 599 ? status : 502;
    this.billingRequired = userMessage.includes("余额不足") || userMessage.includes("付款");
  }
}
