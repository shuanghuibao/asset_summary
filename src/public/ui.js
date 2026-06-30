(function setupSharedUi() {
  function closeAllTips(except) {
    document.querySelectorAll(".help-tip.is-open").forEach((tip) => {
      if (tip !== except) tip.classList.remove("is-open");
    });
  }

  document.addEventListener("click", (event) => {
    const tip = event.target.closest?.(".help-tip");
    if (!tip) {
      closeAllTips();
      return;
    }
    if (tip.tagName !== "BUTTON") return;
    const isOpen = tip.classList.toggle("is-open");
    closeAllTips(isOpen ? tip : null);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllTips();
  });

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.confirmDanger = function confirmDanger({ title, message, details = [], confirmText = "确认", cancelText = "取消" }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "app-dialog";
      const detailItems = details
        .filter(Boolean)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
      dialog.innerHTML = `
        <div class="dialog-card">
          <div class="dialog-header">
            <h3>${escapeHtml(title)}</h3>
            <button type="button" class="btn-ghost" data-dialog-cancel aria-label="关闭">关闭</button>
          </div>
          <p>${escapeHtml(message)}</p>
          ${detailItems ? `<ul class="dialog-detail-list">${detailItems}</ul>` : ""}
          <div class="dialog-actions">
            <button type="button" class="btn-ghost" data-dialog-cancel>${escapeHtml(cancelText)}</button>
            <button type="button" class="btn-ghost danger" data-dialog-confirm>${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;

      let resolved = false;
      const cleanup = (value) => {
        if (resolved) return;
        resolved = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(value);
      };
      dialog.addEventListener("close", () => {
        if (document.body.contains(dialog)) cleanup(false);
      });
      dialog.querySelectorAll("[data-dialog-cancel]").forEach((button) => {
        button.addEventListener("click", () => cleanup(false));
      });
      dialog.querySelector("[data-dialog-confirm]")?.addEventListener("click", () => cleanup(true));
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector("[data-dialog-confirm]")?.focus();
    });
  };
})();
