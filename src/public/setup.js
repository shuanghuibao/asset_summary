const state = window.__SETUP_CONFIG__ || { members: [], items: [] };
const membersForm = document.getElementById("membersForm");
const itemsForm = document.getElementById("itemsForm");
const membersTableBody = document.querySelector("#membersTable tbody");
const ownerMemberSelect = document.getElementById("ownerMemberSelect");
const itemsTableBody = document.querySelector("#itemsTable tbody");
const statusEl = document.getElementById("setupStatus");
const membersSubmit = document.getElementById("membersSubmit");
const itemsSubmit = document.getElementById("itemsSubmit");
const applyTemplateBtn = document.getElementById("applyTemplateBtn");
const showInactiveItems = document.getElementById("showInactiveItems");
const itemSearchInput = document.getElementById("itemSearchInput");
const editSummaryLabel = document.getElementById("editSummaryLabel");
const toggleEditModeBtn = document.getElementById("toggleEditModeBtn");
const saveBar = document.getElementById("saveBar");
const saveHint = document.getElementById("saveHint");
const saveAllBtn = document.getElementById("saveAllBtn");
const tableDeleteHeader = document.getElementById("tableDeleteHeader");
const toggleMemberEditModeBtn = document.getElementById("toggleMemberEditModeBtn");
const memberDeleteHeader = document.getElementById("memberDeleteHeader");
const memberSaveBar = document.getElementById("memberSaveBar");
const memberSaveHint = document.getElementById("memberSaveHint");
const saveMembersBtn = document.getElementById("saveMembersBtn");

let editMode = false;
let draftItems = [];
let memberEditMode = false;
let draftMembers = [];

function kindLabel(kind) {
  const map = { asset: "资产", liability: "负债", income: "收入", expense: "支出" };
  return map[kind] || kind;
}

function assetGroupLabel(group) {
  const map = { cash: "现金/存款", investment: "投资", housing_fund: "公积金", other: "其他" };
  return map[group] || "-";
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function normalizeItem(item) {
  return {
    id: Number(item.id),
    name: String(item.name || ""),
    kind: item.kind,
    asset_group: item.asset_group || null,
    owner_member_id: item.owner_member_id ? Number(item.owner_member_id) : null,
    owner_member_name: item.owner_member_name || "共同",
    is_active: Boolean(item.is_active),
    marked_for_delete: Boolean(item.marked_for_delete),
  };
}

function normalizeMember(member) {
  return {
    id: Number(member.id),
    name: String(member.name || ""),
    is_active: member.is_active !== false,
    marked_for_delete: Boolean(member.marked_for_delete),
  };
}

function cloneDraft(items) {
  return items.map((x) => ({ ...normalizeItem(x), marked_for_delete: false }));
}

function cloneMemberDraft(members) {
  return members.map((x) => ({ ...normalizeMember(x), marked_for_delete: false }));
}

function getOwnerOptionsHtml(selected) {
  const common = `<option value="" ${selected ? "" : "selected"}>共同</option>`;
  const members = state.members
    .filter((m) => m.is_active !== false)
    .map((m) => `<option value="${m.id}" ${Number(selected) === Number(m.id) ? "selected" : ""}>${m.name}</option>`)
    .join("");
  return `${common}${members}`;
}

function getMemberEditSummary() {
  if (!memberEditMode) return { changed: 0, deleted: 0 };
  const origin = new Map(state.members.map((x) => [Number(x.id), normalizeMember(x)]));
  let changed = 0;
  let deleted = 0;
  for (const row of draftMembers) {
    const base = origin.get(Number(row.id));
    if (!base) continue;
    if (row.marked_for_delete) {
      deleted += 1;
      continue;
    }
    if (row.name !== base.name || Boolean(row.is_active) !== Boolean(base.is_active)) {
      changed += 1;
    }
  }
  return { changed, deleted };
}

function updateMemberModeUI() {
  if (!toggleMemberEditModeBtn || !memberDeleteHeader || !memberSaveBar || !memberSaveHint) return;
  if (!memberEditMode) {
    toggleMemberEditModeBtn.textContent = "编辑";
    memberDeleteHeader.hidden = true;
    memberSaveBar.hidden = true;
    return;
  }
  const s = getMemberEditSummary();
  toggleMemberEditModeBtn.textContent = "退出编辑";
  memberDeleteHeader.hidden = false;
  memberSaveBar.hidden = false;
  memberSaveHint.textContent = `待保存：修改 ${s.changed} 位，删除 ${s.deleted} 位`;
}

function getWorkingItems() {
  return editMode ? draftItems : state.items;
}

function getVisibleItems() {
  const showInactive = Boolean(showInactiveItems?.checked);
  const keyword = String(itemSearchInput?.value || "").trim().toLowerCase();
  return getWorkingItems().filter((item) => {
    if (!showInactive && !item.is_active) return false;
    if (!keyword) return true;
    return item.name.toLowerCase().includes(keyword);
  });
}

function getEditSummary() {
  if (!editMode) return { changed: 0, deleted: 0 };
  const origin = new Map(state.items.map((x) => [Number(x.id), normalizeItem(x)]));
  let changed = 0;
  let deleted = 0;
  for (const row of draftItems) {
    const base = origin.get(Number(row.id));
    if (!base) continue;
    if (row.marked_for_delete) {
      deleted += 1;
      continue;
    }
    if (
      row.name !== base.name ||
      row.kind !== base.kind ||
      (row.asset_group || null) !== (base.asset_group || null) ||
      Number(row.owner_member_id || 0) !== Number(base.owner_member_id || 0) ||
      Boolean(row.is_active) !== Boolean(base.is_active)
    ) {
      changed += 1;
    }
  }
  return { changed, deleted };
}

function updateModeUI() {
  if (!editSummaryLabel || !toggleEditModeBtn || !saveBar || !saveHint || !tableDeleteHeader) return;
  if (!editMode) {
    editSummaryLabel.textContent = "浏览模式";
    toggleEditModeBtn.textContent = "编辑";
    saveBar.hidden = true;
    tableDeleteHeader.hidden = true;
    return;
  }
  const s = getEditSummary();
  editSummaryLabel.textContent = `编辑模式 | 修改 ${s.changed} 项，删除 ${s.deleted} 项`;
  toggleEditModeBtn.textContent = "退出编辑";
  saveBar.hidden = false;
  saveHint.textContent = `待保存：修改 ${s.changed} 项，删除 ${s.deleted} 项`;
  tableDeleteHeader.hidden = false;
}

function renderMembers() {
  const rows = memberEditMode ? draftMembers : state.members;
  membersTableBody.innerHTML = rows
    .map((member) => {
      const nameCell = memberEditMode
        ? `<input type="text" class="cell-input" data-member-id="${member.id}" data-member-field="name" value="${member.name.replace(/"/g, "&quot;")}" />`
        : member.name;
      const statusCell = memberEditMode
        ? `<select class="cell-select" data-member-id="${member.id}" data-member-field="is_active">
            <option value="true" ${member.is_active ? "selected" : ""}>启用</option>
            <option value="false" ${member.is_active ? "" : "selected"}>停用</option>
          </select>`
        : member.is_active
          ? '<span class="badge-on">启用</span>'
          : '<span class="badge-off">停用</span>';
      const deleteCell = memberEditMode
        ? `<td><label class="inline-checkbox"><input type="checkbox" data-member-id="${member.id}" data-member-field="marked_for_delete" ${member.marked_for_delete ? "checked" : ""} /> 删除</label></td>`
        : "";
      return `<tr><td>${nameCell}</td><td>${statusCell}</td>${deleteCell}</tr>`;
    })
    .join("");
  if (!rows.length) {
    membersTableBody.innerHTML = `<tr><td colspan="${memberEditMode ? 3 : 2}" class="muted">暂无家庭成员</td></tr>`;
  }
  ownerMemberSelect.innerHTML = getOwnerOptionsHtml(null);
  updateMemberModeUI();
}

function renderItems() {
  const rows = getVisibleItems();
  itemsTableBody.innerHTML = rows
    .map((item) => {
      const nameCell = editMode
        ? `<input type="text" class="cell-input" data-id="${item.id}" data-field="name" value="${item.name.replace(/"/g, "&quot;")}" />`
        : item.name;
      const kindCell = editMode
        ? `<select class="cell-select" data-id="${item.id}" data-field="kind">
            <option value="asset" ${item.kind === "asset" ? "selected" : ""}>资产</option>
            <option value="liability" ${item.kind === "liability" ? "selected" : ""}>负债</option>
            <option value="income" ${item.kind === "income" ? "selected" : ""}>收入</option>
            <option value="expense" ${item.kind === "expense" ? "selected" : ""}>支出</option>
          </select>`
        : kindLabel(item.kind);
      const subCell = editMode
        ? `<select class="cell-select" data-id="${item.id}" data-field="asset_group" ${item.kind === "asset" ? "" : "disabled"}>
            <option value="cash" ${item.asset_group === "cash" ? "selected" : ""}>现金存款</option>
            <option value="investment" ${item.asset_group === "investment" ? "selected" : ""}>投资</option>
            <option value="housing_fund" ${item.asset_group === "housing_fund" ? "selected" : ""}>公积金</option>
            <option value="other" ${!item.asset_group || item.asset_group === "other" ? "selected" : ""}>其他</option>
          </select>`
        : assetGroupLabel(item.asset_group);
      const ownerCell = editMode
        ? `<select class="cell-select" data-id="${item.id}" data-field="owner_member_id">${getOwnerOptionsHtml(item.owner_member_id)}</select>`
        : item.owner_member_name || "共同";
      const statusCell = editMode
        ? `<select class="cell-select" data-id="${item.id}" data-field="is_active">
            <option value="true" ${item.is_active ? "selected" : ""}>启用</option>
            <option value="false" ${item.is_active ? "" : "selected"}>停用</option>
          </select>`
        : item.is_active
          ? '<span class="badge-on">启用</span>'
          : '<span class="badge-off">停用</span>';
      const deleteCell = editMode
        ? `<td><label class="inline-checkbox"><input type="checkbox" data-id="${item.id}" data-field="marked_for_delete" ${item.marked_for_delete ? "checked" : ""} /> 删除</label></td>`
        : "";
      return `<tr>
        <td>${nameCell}</td>
        <td>${kindCell}</td>
        <td>${subCell}</td>
        <td>${ownerCell}</td>
        <td>${statusCell}</td>
        ${deleteCell}
      </tr>`;
    })
    .join("");

  if (!rows.length) {
    itemsTableBody.innerHTML = `<tr><td colspan="${editMode ? 6 : 5}" class="muted">当前筛选下暂无科目</td></tr>`;
  }
  updateModeUI();
}

function updateDraftField(id, field, value) {
  const row = draftItems.find((x) => Number(x.id) === Number(id));
  if (!row) return;
  if (field === "name") row.name = String(value || "");
  if (field === "kind") {
    row.kind = value;
    if (row.kind !== "asset") row.asset_group = null;
    if (row.kind === "asset" && !row.asset_group) row.asset_group = "other";
    renderItems();
    return;
  }
  if (field === "asset_group") row.asset_group = value;
  if (field === "owner_member_id") {
    row.owner_member_id = value ? Number(value) : null;
    const owner = state.members.find((m) => Number(m.id) === Number(row.owner_member_id));
    row.owner_member_name = owner?.name || "共同";
  }
  if (field === "is_active") row.is_active = value === "true";
  if (field === "marked_for_delete") row.marked_for_delete = Boolean(value);
  updateModeUI();
}

async function postForm(form, submitBtn) {
  submitBtn.disabled = true;
  submitBtn.textContent = "保存中...";
  try {
    const body = new URLSearchParams(new FormData(form)).toString();
    const res = await fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" },
      body,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.message || "保存失败");
    state.members = json.config.members.map(normalizeMember);
    state.items = json.config.items.map(normalizeItem);
    renderMembers();
    renderItems();
    form.reset();
    setStatus("已保存，配置已即时更新。");
  } catch (err) {
    setStatus(err.message || "保存失败", true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = form.id === "membersForm" ? "保存成员" : "添加科目";
  }
}

async function postJson(url, payload, message) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || "操作失败");
    state.members = data.config.members.map(normalizeMember);
    state.items = data.config.items.map(normalizeItem);
    renderMembers();
    renderItems();
    setStatus(message || "更新成功");
    return data;
  } catch (err) {
    setStatus(err.message || "操作失败", true);
    throw err;
  }
}

membersForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  postForm(membersForm, membersSubmit);
});

toggleMemberEditModeBtn?.addEventListener("click", () => {
  if (!memberEditMode) {
    memberEditMode = true;
    draftMembers = cloneMemberDraft(state.members);
    setStatus("已进入成员编辑模式。");
    renderMembers();
    return;
  }
  memberEditMode = false;
  draftMembers = [];
  setStatus("已退出成员编辑模式。未保存的成员修改已取消。");
  renderMembers();
});

membersTableBody?.addEventListener("input", (e) => {
  if (!memberEditMode) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const id = Number(target.dataset.memberId);
  const field = target.dataset.memberField;
  if (!id || !field) return;
  const row = draftMembers.find((x) => Number(x.id) === id);
  if (!row) return;
  if (field === "name") row.name = target.value;
  updateMemberModeUI();
});

membersTableBody?.addEventListener("change", (e) => {
  if (!memberEditMode) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const id = Number(target.dataset.memberId);
  const field = target.dataset.memberField;
  if (!id || !field) return;
  const row = draftMembers.find((x) => Number(x.id) === id);
  if (!row) return;
  if (field === "is_active") row.is_active = target.value === "true";
  if (field === "marked_for_delete" && target instanceof HTMLInputElement) row.marked_for_delete = target.checked;
  updateMemberModeUI();
});

saveMembersBtn?.addEventListener("click", async () => {
  if (!memberEditMode) return;
  const payload = {
    members: draftMembers.map((x) => ({
      id: x.id,
      name: String(x.name || "").trim(),
      is_active: Boolean(x.is_active),
      marked_for_delete: Boolean(x.marked_for_delete),
    })),
  };
  saveMembersBtn.disabled = true;
  saveMembersBtn.textContent = "保存中...";
  try {
    const data = await postJson("/setup/members/batch-save", payload);
    state.members = data.config.members.map(normalizeMember);
    state.items = data.config.items.map(normalizeItem);
    memberEditMode = false;
    draftMembers = [];
    renderMembers();
    renderItems();
    if (data.skippedDeleteCount > 0) {
      setStatus(`成员保存完成：更新 ${data.updatedCount} 位，删除 ${data.deletedCount} 位，${data.skippedDeleteCount} 位因有关联科目已跳过。`);
    } else {
      setStatus(`成员保存完成：更新 ${data.updatedCount} 位，删除 ${data.deletedCount} 位。`);
    }
  } finally {
    saveMembersBtn.disabled = false;
    saveMembersBtn.textContent = "保存成员";
  }
});

itemsForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  postForm(itemsForm, itemsSubmit);
});

applyTemplateBtn?.addEventListener("click", async () => {
  applyTemplateBtn.disabled = true;
  applyTemplateBtn.textContent = "应用中...";
  try {
    await postJson("/setup/templates/basic", {}, "推荐模板已应用。");
  } finally {
    applyTemplateBtn.disabled = false;
    applyTemplateBtn.textContent = "一键套用推荐模板";
  }
});

toggleEditModeBtn?.addEventListener("click", () => {
  if (!editMode) {
    editMode = true;
    draftItems = cloneDraft(state.items);
    setStatus("已进入编辑模式。可直接在表格中修改。");
    renderItems();
    return;
  }
  editMode = false;
  draftItems = [];
  setStatus("已退出编辑模式。未保存的修改已取消。");
  renderItems();
});

saveAllBtn?.addEventListener("click", async () => {
  if (!editMode) return;
  const payload = {
    items: draftItems.map((x) => ({
      id: x.id,
      name: String(x.name || "").trim(),
      kind: x.kind,
      asset_group: x.kind === "asset" ? x.asset_group || "other" : null,
      owner_member_id: x.owner_member_id || null,
      is_active: Boolean(x.is_active),
      marked_for_delete: Boolean(x.marked_for_delete),
    })),
  };

  saveAllBtn.disabled = true;
  saveAllBtn.textContent = "保存中...";
  try {
    const data = await postJson("/setup/items/batch-save", payload);
    editMode = false;
    draftItems = [];
    renderItems();
    if (data.skippedDeleteCount > 0) {
      setStatus(`保存完成：更新 ${data.updatedCount} 项，删除 ${data.deletedCount} 项，${data.skippedDeleteCount} 项因有历史记录已跳过。`);
    } else {
      setStatus(`保存完成：更新 ${data.updatedCount} 项，删除 ${data.deletedCount} 项。`);
    }
  } finally {
    saveAllBtn.disabled = false;
    saveAllBtn.textContent = "保存";
  }
});

itemsTableBody?.addEventListener("input", (e) => {
  if (!editMode) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const id = target.dataset.id;
  const field = target.dataset.field;
  if (!id || !field) return;
  updateDraftField(Number(id), field, target.value);
});

itemsTableBody?.addEventListener("change", (e) => {
  if (!editMode) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const id = target.dataset.id;
  const field = target.dataset.field;
  if (!id || !field) return;
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    updateDraftField(Number(id), field, target.checked);
    return;
  }
  updateDraftField(Number(id), field, target.value);
});

itemSearchInput?.addEventListener("input", renderItems);
showInactiveItems?.addEventListener("change", renderItems);

state.members = state.members.map(normalizeMember);
state.items = state.items.map(normalizeItem);
renderMembers();
renderItems();
