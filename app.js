const views = ["welcome", "api", "region", "plan", "confirm", "progress", "failure", "server"];
const progressByView = {
  welcome: 8,
  api: 18,
  region: 32,
  plan: 48,
  confirm: 64,
  progress: 84,
  failure: 84,
  server: 100,
};
const labelsByView = {
  welcome: "开始",
  api: "输入 API",
  region: "选择地区",
  plan: "选择套餐",
  confirm: "确认创建",
  progress: "创建中",
  failure: "创建失败",
  server: "已完成",
};

const preferredRegionIds = ["nrt", "sgp", "lax", "sjc", "sea", "ewr"];
const preferredPlanIds = ["vc2-1c-1gb", "vc2-1c-2gb"];
const draftKey = "vps-pilot-config-draft";

const state = {
  regions: [],
  plans: [],
  selectedRegionId: "nrt",
  selectedPlanId: "vc2-1c-1gb",
  apiStatus: "waiting",
  apiValidated: false,
  apiSession: "",
  provisioningId: "",
  draftSavedAt: "",
  rememberApiKey: true,
};

const toast = document.querySelector(".toast");
const progressFill = document.querySelector("#progress-fill");
const stepLabel = document.querySelector("#step-label");
const buildMessage = document.querySelector("#build-message");
const regionList = document.querySelector("#region-list");
const planList = document.querySelector("#plan-list");
const apiForm = document.querySelector("#api-form");
const apiKeyInput = document.querySelector("#api-key");
const rememberApiKey = document.querySelector("#remember-api-key");
const apiError = document.querySelector("#api-error");
const verifyApiButton = document.querySelector("#verify-api");
const terms = document.querySelector("#terms");
const startCreate = document.querySelector("#start-create");
const apiGuideModal = document.querySelector("#api-guide-modal");
const openApiGuide = document.querySelector("#open-api-guide");
const openApiGuideCopy = document.querySelector("#open-api-guide-copy");
const closeApiGuide = document.querySelector("#close-api-guide");
const imageModal = document.querySelector("#image-modal");
const imageModalTitle = document.querySelector("#image-modal-title");
const imageModalImg = document.querySelector("#image-modal-img");
const closeImageModal = document.querySelector("#close-image-modal");
const pasteApiKey = document.querySelector("#paste-api-key");
const serverIp = document.querySelector("#server-ip");
const serverStatus = document.querySelector("#server-status");
const sshIp = document.querySelector("#ssh-ip");
const sshUser = document.querySelector("#ssh-user");
const sshPass = document.querySelector("#ssh-pass");
const sshPassRow = document.querySelector("#ssh-pass-row");
const passwordHelp = document.querySelector("#password-help");
const passwordConsoleLink = document.querySelector("#password-console-link");
const deleteServer = document.querySelector("#delete-server");
const openNodeGuide = document.querySelector("#open-node-guide");
const nodeGuideModal = document.querySelector("#node-guide-modal");
const closeNodeGuide = document.querySelector("#close-node-guide");
const nodePromptOutput = document.querySelector("#node-prompt-output");
const copyNodePrompt = document.querySelector("#copy-node-prompt");
const billingLink = document.querySelector("#billing-link");

init();

async function init() {
  hydrateDraft();
  bindStaticEvents();
  await loadVultrData();
  renderRegions();
  renderPlans();
  syncSelectedSummary();
  saveDraft();
}

function bindStaticEvents() {
  document.querySelectorAll("[data-next]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const target = button.dataset.next;
      if (target === "confirm") {
        saveDraft();
      }
      showView(target);
    });
  });

  apiForm.addEventListener("submit", (event) => {
    event.preventDefault();
    validateApiAndContinue();
  });

  apiKeyInput.addEventListener("input", () => {
    apiError.hidden = true;
    state.apiValidated = false;
    state.apiStatus = "waiting";
    state.apiSession = "";
    syncSelectedSummary();
    saveDraft();
  });

  rememberApiKey.addEventListener("change", () => {
    state.rememberApiKey = rememberApiKey.checked;
    saveDraft();
  });

  openApiGuide.addEventListener("click", () => {
    apiGuideModal.showModal();
  });

  openApiGuideCopy.addEventListener("click", fillApiKeyFromClipboard);

  closeApiGuide.addEventListener("click", () => {
    apiGuideModal.close();
  });

  apiGuideModal.addEventListener("click", (event) => {
    if (event.target === apiGuideModal) {
      apiGuideModal.close();
    }
  });

  document.querySelectorAll("[data-zoom-image]").forEach((button) => {
    button.addEventListener("click", () => {
      imageModalTitle.textContent = button.dataset.zoomTitle || "查看图片";
      imageModalImg.src = button.dataset.zoomImage;
      imageModalImg.alt = button.querySelector("img") ? button.querySelector("img").alt : "";
      imageModal.showModal();
    });
  });

  closeImageModal.addEventListener("click", () => {
    imageModal.close();
    imageModalImg.removeAttribute("src");
  });

  imageModal.addEventListener("click", (event) => {
    if (event.target === imageModal) {
      imageModal.close();
      imageModalImg.removeAttribute("src");
    }
  });

  pasteApiKey.addEventListener("click", fillApiKeyFromClipboard);

  terms.addEventListener("change", () => {
    startCreate.disabled = !terms.checked;
  });

  startCreate.addEventListener("click", () => {
    saveDraft();
    startProvisioning();
  });

  deleteServer.addEventListener("click", deleteCurrentServer);
  openNodeGuide.addEventListener("click", openNodeSetupGuide);
  closeNodeGuide.addEventListener("click", () => {
    nodeGuideModal.close();
  });
  nodeGuideModal.addEventListener("click", (event) => {
    if (event.target === nodeGuideModal) {
      nodeGuideModal.close();
    }
  });
  copyNodePrompt.addEventListener("click", copyNodeSetupPrompt);

  document.querySelector("#toggle-ssh").addEventListener("click", (event) => {
    const fields = document.querySelector(".secret-fields");
    const isHidden = fields.hidden;
    fields.hidden = !isHidden;
    event.currentTarget.textContent = isHidden ? "隐藏" : "显示";
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const value = button.dataset.copy;
      const copied = await copyText(value);
      showToast(copied ? "已复制" : "复制失败，请手动复制");
    });
  });
}

async function loadVultrData() {
  try {
    const responses = await Promise.all([
      fetch("./vultr-regions.json", { cache: "no-store" }),
      fetch("./vultr-plans-vc2.json", { cache: "no-store" }),
    ]);
    const regionsData = await responses[0].json();
    const plansData = await responses[1].json();
    state.regions = regionsData.regions || [];
    state.plans = (plansData.plans || []).filter((plan) => preferredPlanIds.includes(plan.id));
  } catch (error) {
    state.regions = fallbackRegions();
    state.plans = fallbackPlans();
    showToast("Vultr 数据读取失败，已使用备用信息");
  }

  if (!findRegion(state.selectedRegionId)) {
    state.selectedRegionId = state.regions[0] ? state.regions[0].id : "nrt";
  }
  if (!findPlan(state.selectedPlanId)) {
    state.selectedPlanId = state.plans[0] ? state.plans[0].id : "vc2-1c-1gb";
  }
}

function renderRegions() {
  const availableRegions = state.regions
    .filter((region) => preferredRegionIds.includes(region.id))
    .sort((a, b) => preferredRegionIds.indexOf(a.id) - preferredRegionIds.indexOf(b.id));

  regionList.innerHTML = availableRegions
    .map((region) => {
      const checked = region.id === state.selectedRegionId ? "checked" : "";
      const selected = region.id === state.selectedRegionId ? " is-selected" : "";
      return `
        <label class="choice${selected}">
          <input ${checked} name="region" type="radio" value="${region.id}">
          <span>
            <strong>${formatRegion(region)}</strong>
            <small>${formatRegionHint(region)}</small>
          </span>
        </label>
      `;
    })
    .join("");

  regionList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      state.selectedRegionId = input.value;
      renderRegions();
      renderPlans();
      syncSelectedSummary();
      saveDraft();
    });
  });
}

function renderPlans() {
  const plans = state.plans.filter((plan) => plan.locations.includes(state.selectedRegionId));

  if (!plans.some((plan) => plan.id === state.selectedPlanId)) {
    state.selectedPlanId = plans[0] ? plans[0].id : state.plans[0] ? state.plans[0].id : "vc2-1c-1gb";
  }

  planList.innerHTML = plans
    .map((plan) => {
      const checked = plan.id === state.selectedPlanId ? "checked" : "";
      const selected = plan.id === state.selectedPlanId ? " is-selected" : "";
      return `
        <label class="plan${selected}">
          <input ${checked} name="plan" type="radio" value="${plan.id}">
          <span>
            <strong>${formatPlanName(plan)}</strong>
            <small>${formatPlanSpec(plan)}</small>
          </span>
          <b>${formatMonthlyCost(plan)}</b>
        </label>
      `;
    })
    .join("");

  planList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      state.selectedPlanId = input.value;
      renderPlans();
      syncSelectedSummary();
      saveDraft();
    });
  });
}

async function validateApiAndContinue() {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey.length < 20) {
    apiError.textContent = "API Key 看起来太短，请检查后重试。";
    apiError.hidden = false;
    apiKeyInput.focus();
    return;
  }

  state.apiStatus = "checking";
  syncSelectedSummary();
  verifyApiButton.disabled = true;
    verifyApiButton.textContent = "保存中";
  apiError.hidden = true;

  try {
    const response = await fetch("/api/vultr/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "API 无法验证，请稍后重试。");
    }

    state.apiStatus = "valid";
    state.apiValidated = true;
    state.apiSession = result.api_session || "";
    if (!state.rememberApiKey) {
      apiKeyInput.value = "";
    }
    saveDraft();
    syncSelectedSummary();
    showToast("已保存 API，请继续选择配置");
    showView("region");
  } catch (error) {
    state.apiStatus = "invalid";
    state.apiValidated = false;
    state.apiSession = "";
    syncSelectedSummary();
    apiError.textContent = error.message || "API Key 无法保存，请稍后重试。";
    apiError.hidden = false;
    apiKeyInput.focus();
  } finally {
    verifyApiButton.disabled = false;
    verifyApiButton.textContent = "保存并继续";
  }
}

async function fillApiKeyFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    showToast("浏览器不允许读取剪贴板，请手动粘贴");
    apiGuideModal.close();
    showView("api");
    apiKeyInput.focus();
    return;
  }

  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      showToast("剪贴板为空，请手动粘贴");
      return;
    }
    apiKeyInput.value = text;
    apiError.hidden = true;
    saveDraft();
    apiGuideModal.close();
    showView("api");
    apiKeyInput.focus();
    showToast("已填入 API Key");
  } catch (error) {
    showToast("读取剪贴板失败，请手动粘贴");
    apiGuideModal.close();
    showView("api");
    apiKeyInput.focus();
  }
}

function syncSelectedSummary() {
  const region = findRegion(state.selectedRegionId);
  const plan = findPlan(state.selectedPlanId);
  const regionText = region ? formatRegion(region) : "未选择";
  const planText = plan ? `${formatPlanName(plan)} ${plan.vcpu_count} 核 ${formatGb(plan.ram)}G` : "未选择";
  const costText = plan ? formatMonthlyCost(plan) : "未选择";

  setText("#fact-plan", plan ? `${plan.vcpu_count} 核 ${formatGb(plan.ram)}G` : "选择套餐");
  setText("#fact-cost", plan ? `月费 ${costText.replace("/月", "")}` : "选择价格");
  setText("#confirm-region", regionText);
  setText("#confirm-plan", planText);
  setText("#confirm-cost", costText);
  setApiStatus(state.apiStatus);
  setText("#server-region", regionText);
  setText("#server-plan", planText);
}

function showView(name) {
  views.forEach((view) => {
    document.querySelector(`#view-${view}`).classList.toggle("is-visible", view === name);
  });
  progressFill.style.width = `${progressByView[name]}%`;
  stepLabel.textContent = labelsByView[name];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function startProvisioning() {
  if (!state.apiValidated || !state.apiSession) {
    showToast("请先输入 Vultr API");
    showView("api");
    return;
  }

  showView("progress");
  buildMessage.textContent = "正在提交 Vultr 创建请求";
  startCreate.disabled = true;

  try {
    const response = await fetch("/api/provisioning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_session: state.apiSession,
        region: state.selectedRegionId,
        plan: state.selectedPlanId,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || "创建请求失败，请稍后重试。");
      error.billingRequired = Boolean(result.billing_required);
      throw error;
    }

    state.provisioningId = result.provisioning_id;
    state.apiSession = "";
    await pollProvisioning();
  } catch (error) {
    showFailure(error.message || "创建请求失败，请稍后重试。", Boolean(error.billingRequired));
  } finally {
    startCreate.disabled = false;
  }
}

async function pollProvisioning() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await fetch(`/api/provisioning/${encodeURIComponent(state.provisioningId)}`, {
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || "读取创建进度失败。");
      error.billingRequired = Boolean(result.billing_required);
      throw error;
    }

    buildMessage.textContent = result.message || "正在创建服务器";

    if (result.status === "running") {
      renderServer(result.server);
      showView("server");
      return;
    }
    if (result.status === "failed") {
      showFailure(result.error || "创建失败，请稍后重试。", Boolean(result.billing_required));
      return;
    }
    await wait(3000);
  }

  showFailure("创建时间过长，请稍后刷新 Vultr 控制台确认。");
}

function renderServer(server) {
  const ip = server && server.ip_address ? server.ip_address : "未返回";
  const region = server && server.region ? server.region : "";
  const plan = server && server.plan ? server.plan : "";
  serverIp.textContent = ip;
  serverStatus.textContent = server && server.status ? server.status : "运行中";
  if (region) {
    setText("#server-region", region);
  }
  if (plan) {
    setText("#server-plan", plan);
  }
  sshIp.value = ip;
  sshUser.value = server && server.ssh_username ? server.ssh_username : "root";
  const rawPassword = server && server.ssh_password ? server.ssh_password : "";
  const passwordMissing = !rawPassword || rawPassword.includes("未返回") || rawPassword.includes("控制台查看") || rawPassword.includes("重置");
  const password = passwordMissing ? "Vultr 未返回密码" : rawPassword;
  sshPass.value = password;
  sshPassRow.hidden = passwordMissing;
  passwordHelp.hidden = !passwordMissing;
  passwordConsoleLink.href = server && server.instance_id
    ? `https://console.vultr.com/compute/instances/${encodeURIComponent(server.instance_id)}`
    : "https://console.vultr.com/compute/";
}

async function deleteCurrentServer() {
  if (!state.provisioningId) {
    showToast("没有可删除的服务器");
    return;
  }
  const confirmed = window.confirm("确定彻底删除这台 Vultr 服务器吗？删除后无法恢复。");
  if (!confirmed) return;

  deleteServer.disabled = true;
  deleteServer.textContent = "删除中";
  try {
    const response = await fetch(`/api/provisioning/${encodeURIComponent(state.provisioningId)}`, {
      method: "DELETE",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "删除失败，请到 Vultr 控制台处理。");
    }
    serverStatus.textContent = "已删除";
    showToast("服务器已删除");
    showView("api");
  } catch (error) {
    showToast(error.message || "删除失败，请到 Vultr 控制台处理");
  } finally {
    deleteServer.disabled = false;
    deleteServer.textContent = "删除当前服务器";
  }
}

function openNodeSetupGuide() {
  nodePromptOutput.value = buildNodeSetupPrompt();
  nodeGuideModal.showModal();
}

async function copyNodeSetupPrompt() {
  const prompt = nodePromptOutput.value || buildNodeSetupPrompt();
  const copied = await copyText(prompt, nodePromptOutput);
  showToast(copied ? "提示词已复制" : "复制失败，请手动复制");
}

function buildNodeSetupPrompt() {
  const ip = sshIp.value || "<填写服务器公网IP>";
  const username = sshUser.value || "root";
  const password = sshPass.value || "<填写服务器密码>";
  return [
    `IP Address: ${ip}`,
    `Username: ${username}`,
    `Password: ${password}`,
    "",
    "请登录这台 VPS，自动配置一个兼容 v2rayN 和 Shadowrocket 的节点服务。",
    "",
    "要求：",
    "1. 使用 sing-box 或 Xray，优先选择不需要域名的通用稳定方案。",
    "2. 没有域名，只有公网 IP。",
    "3. 自动选择当前安全稳定、客户端兼容性好的加密方式。",
    "4. 自动生成强密码或密钥，不要使用弱密码。",
    "5. 自动放行需要的 TCP/UDP 端口。",
    "6. 自动启动服务，并设置开机自启。",
    "7. 配置完成后只输出一个 v2rayN 和 Shadowrocket 可导入的节点链接。",
    "8. 不要输出安装过程、密码、配置文件内容、日志或多余说明。",
    "9. 如果失败，只输出一句简短失败原因。",
    "",
    "最终输出格式只允许是：",
    "节点链接：",
    "<链接>",
  ].join("\n");
}

function showFailure(message, billingRequired) {
  setText("#failure-reason", message);
  billingLink.hidden = !billingRequired;
  showView("failure");
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hydrateDraft() {
  try {
    const raw = localStorage.getItem(draftKey);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.selectedRegionId) state.selectedRegionId = draft.selectedRegionId;
    if (draft.selectedPlanId) state.selectedPlanId = draft.selectedPlanId;
    state.rememberApiKey = draft.rememberApiKey !== false;
    rememberApiKey.checked = state.rememberApiKey;
    if (state.rememberApiKey && draft.apiKey) {
      apiKeyInput.value = draft.apiKey;
    }
  } catch (error) {
    localStorage.removeItem(draftKey);
  }
}

function saveDraft() {
  state.draftSavedAt = new Date().toISOString();
  const draft = {
    selectedRegionId: state.selectedRegionId,
    selectedPlanId: state.selectedPlanId,
    rememberApiKey: state.rememberApiKey,
    savedAt: state.draftSavedAt,
  };
  const apiKey = apiKeyInput.value.trim();
  if (state.rememberApiKey && apiKey) {
    draft.apiKey = apiKey;
  }
  localStorage.setItem(draftKey, JSON.stringify(draft));
}

function findRegion(id) {
  return state.regions.find((region) => region.id === id);
}

function findPlan(id) {
  return state.plans.find((plan) => plan.id === id);
}

function formatRegion(region) {
  return `${countryName(region.country)} ${region.city}`;
}

function formatRegionHint(region) {
  if (region.id === "nrt") return "亚洲用户常用";
  if (region.id === "sgp") return "东南亚线路";
  if (region.id === "lax") return "美国西海岸";
  if (region.id === "sjc") return "美国西海岸";
  if (region.id === "sea") return "美国西北部";
  if (region.id === "ewr") return "美国东海岸";
  return region.continent;
}

function formatPlanName(plan) {
  if (plan.id === "vc2-1c-1gb") return "基础款";
  if (plan.id === "vc2-1c-2gb") return "舒适款";
  return plan.id;
}

function formatPlanSpec(plan) {
  return `${plan.vcpu_count} 核 ${formatGb(plan.ram)}G / ${plan.disk}GB SSD / ${formatGb(plan.bandwidth)}TB 流量`;
}

function formatMonthlyCost(plan) {
  const regionCost = plan.location_cost && plan.location_cost[state.selectedRegionId];
  const override = regionCost && regionCost.monthly_cost;
  const cost = override !== undefined && override !== null ? override : plan.monthly_cost;
  return `$${cost}/月`;
}

function formatGb(mb) {
  return Number(mb / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function countryName(code) {
  const names = {
    JP: "日本",
    SG: "新加坡",
    US: "美国",
  };
  return names[code] || code;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function setApiStatus(status) {
  const statusElement = document.querySelector("#confirm-api");
  const labelElement = document.querySelector("#confirm-api-label");
  if (!statusElement || !labelElement) return;

  statusElement.className = `status-pill is-${status}`;
  const labels = {
    waiting: "未填写",
    checking: "保存中",
    valid: "已填写",
    invalid: "格式错误",
  };
  labelElement.textContent = labels[status] || labels.waiting;
}

async function copyText(text, sourceElement) {
  if (!text) return false;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Fall back to the selection-based copy path below.
    }
  }

  const element = sourceElement || document.createElement("textarea");
  const shouldRemove = !sourceElement;
  if (shouldRemove) {
    element.value = text;
    element.setAttribute("readonly", "");
    element.style.left = "-9999px";
    element.style.position = "fixed";
    element.style.top = "0";
    document.body.appendChild(element);
  }

  element.focus();
  element.select();
  element.setSelectionRange(0, element.value.length);

  try {
    return document.execCommand("copy");
  } catch (error) {
    return false;
  } finally {
    if (shouldRemove) {
      element.remove();
    }
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 1800);
}

function fallbackRegions() {
  return [
    { id: "nrt", city: "Tokyo", country: "JP", continent: "Asia" },
    { id: "sgp", city: "Singapore", country: "SG", continent: "Asia" },
    { id: "lax", city: "Los Angeles", country: "US", continent: "North America" },
  ];
}

function fallbackPlans() {
  return [
    {
      id: "vc2-1c-1gb",
      vcpu_count: 1,
      ram: 1024,
      disk: 25,
      bandwidth: 1024,
      monthly_cost: 5,
      locations: ["nrt", "sgp", "lax"],
      location_cost: {},
    },
    {
      id: "vc2-1c-2gb",
      vcpu_count: 1,
      ram: 2048,
      disk: 55,
      bandwidth: 2048,
      monthly_cost: 10,
      locations: ["nrt", "sgp", "lax"],
      location_cost: {},
    },
  ];
}
