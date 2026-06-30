(function setupEntryDraftAndValidation() {
  const form = document.getElementById("entryForm");
  if (!form) return;

  const draftKey = "familyAssetEntryDraft";
  const statusEl = document.getElementById("entryDraftStatus");
  const changeSummaryEl = document.getElementById("entryChangeSummary");
  const clearBtn = document.getElementById("clearEntryDraftBtn");
  const shouldRestoreDraft = Boolean(window.__ENTRY_SHOULD_RESTORE_DRAFT__);
  let initialValues = {};

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function formToObject() {
    return Object.fromEntries(new FormData(form).entries());
  }

  function updateChangeSummary() {
    if (!changeSummaryEl) return;
    const current = formToObject();
    const changedCount = Object.entries(current).filter(([name, value]) => {
      if (!name.startsWith("item_") && name !== "stock_pnl_manual" && name !== "period_date" && name !== "note") return false;
      return String(value ?? "") !== String(initialValues[name] ?? "");
    }).length;
    changeSummaryEl.textContent = changedCount ? `有 ${changedCount} 项修改待保存` : "尚未修改";
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
      updateChangeSummary();
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
    updateChangeSummary();
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

  initialValues = formToObject();
  restoreDraft();
  updateChangeSummary();

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
    let confirmed = false;
    deleteForm.addEventListener("submit", async (event) => {
      if (confirmed) return;
      event.preventDefault();
      const periodDate = deleteForm.dataset.periodDate || "该周期";
      const note = deleteForm.dataset.periodNote || "无备注";
      const ok = await window.confirmDanger({
        title: "删除历史快照",
        message: `将删除 ${periodDate} 快照及所有明细，趋势图会重新计算。`,
        details: [`备注：${note}`, "该操作不可撤销，请确认已经不再需要这期记录。"],
        confirmText: "确认删除",
      });
      if (!ok) return;
      confirmed = true;
      deleteForm.submit();
    });
  });
})();
