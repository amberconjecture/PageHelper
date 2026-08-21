import { getSiteOptions, loadSiteSelections, requestSiteSelection } from "../site-selection.js";

const siteList = document.querySelector("#site-list");
const status = document.querySelector("#status");
const optionTemplate = document.querySelector("#site-option-template");

void initialize();

async function initialize() {
  try {
    await loadSiteSelections();
    renderOptions();
    updateStatus();
  } catch (error) {
    showError(`读取配置失败：${error.message}`);
  }
}

function renderOptions() {
  const options = getSiteOptions();
  siteList.replaceChildren();

  if (!options.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "暂时没有可选择的网站，请先在 config.js 中添加配置。";
    siteList.append(emptyState);
    return;
  }

  for (const option of options) {
    const fragment = optionTemplate.content.cloneNode(true);
    const checkbox = fragment.querySelector(".site-checkbox");
    const label = fragment.querySelector(".site-label");
    const description = fragment.querySelector(".site-description");

    checkbox.dataset.siteId = option.id;
    checkbox.checked = option.enabled;
    checkbox.setAttribute("aria-label", `${option.label}同步`);
    label.textContent = option.label;
    description.textContent = option.description;
    description.hidden = !option.description;
    checkbox.addEventListener("change", handleSelectionChange);

    siteList.append(fragment);
  }
}

async function handleSelectionChange(event) {
  const checkbox = event.currentTarget;
  const requestedState = checkbox.checked;
  checkbox.disabled = true;
  status.classList.remove("error");
  status.textContent = "正在应用…";

  try {
    await requestSiteSelection(checkbox.dataset.siteId, requestedState);
    updateStatus();
  } catch (error) {
    checkbox.checked = !requestedState;
    showError(`保存失败：${error.message}`);
  } finally {
    checkbox.disabled = false;
  }
}

function updateStatus() {
  const checkboxes = [...siteList.querySelectorAll(".site-checkbox")];
  const enabledCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  status.classList.remove("error");
  status.textContent = enabledCount ? `已启用 ${enabledCount} 个网站，配置会立即生效` : "尚未启用网站";
}

function showError(message) {
  status.classList.add("error");
  status.textContent = message;
}
