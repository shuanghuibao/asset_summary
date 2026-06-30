(function setupEntryDraftAndValidation() {
  const form = document.getElementById("entryForm");
  if (!form) return;

  const draftKey = "familyAssetEntryDraft";
  const statusEl = document.getElementById("entryDraftStatus");
  const clearBtn = document.getElementById("clearEntryDraftBtn");
  const shouldRestoreDraft = Boolean(window.__ENTRY_SHOULD_RESTORE_DRAFT__);

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function formToObject() {
    return Object.fromEntries(new FormData(form).entries());
  }

  function restoreDraft() {
    if (!shouldRestoreDraft) return;
    const raw = localStorage.getItem(draftKey);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      for (const [name, value] of Object.entries(draft.values || {})) {
        const field = form.elements.namedItem(name);
        if (field && "value" in field) field.value = value;
      }
      setStatus(`已恢复 ${draft.savedAt || ""} 的本地草稿`);
    } catch (_err) {
      localStorage.removeItem(draftKey);
    }
  }

  function saveDraft() {
    const payload = {
      savedAt: new Date().toLocaleString("zh-CN"),
      values: formToObject(),
    };
    localStorage.setItem(draftKey, JSON.stringify(payload));
    setStatus("草稿已自动保存");
  }

  function validateBeforeSubmit() {
    const data = formToObject();
    const errors = [];
    if (!data.period_date) errors.push("请选择统计日期。");

    let hasNonZeroAmount = false;
    for (const [name, rawValue] of Object.entries(data)) {
      if (name !== "stock_pnl_manual" && !name.startsWith("item_")) continue;
      const text = String(rawValue || "").trim();
      if (!text) continue;
      const value = Number(text);
      if (!Number.isFinite(value)) {
        errors.push("金额字段只能填写数字。");
        break;
      }
      if (value !== 0) hasNonZeroAmount = true;
    }
    if (!hasNonZeroAmount) errors.push("请至少填写一个非零金额。");
    return errors;
  }

  restoreDraft();

  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  form.addEventListener("submit", (event) => {
    const errors = validateBeforeSubmit();
    if (errors.length) {
      event.preventDefault();
      alert(errors.join("\n"));
      return;
    }
    localStorage.removeItem(draftKey);
  });

  clearBtn?.addEventListener("click", () => {
    localStorage.removeItem(draftKey);
    setStatus("本地草稿已清除");
  });

  document.querySelectorAll(".inline-delete-form").forEach((deleteForm) => {
    deleteForm.addEventListener("submit", (event) => {
      if (!confirm("确定删除这个历史快照吗？该操作会同步删除对应明细。")) {
        event.preventDefault();
      }
    });
  });
})();
