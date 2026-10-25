// 本機送出紀錄（localStorage）：每次「全部送出」存一筆，重送時更新同一筆。列表介面在後續 PR。
// 瀏覽器是 window.Records，Node 用 require（可傳入假的 storage 測試）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Records = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'snn.records.v1';
  const MAX = 200;

  function create(storage) {
    const store = storage;
    function list() {
      try { const v = JSON.parse(store.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    function save(all) {
      try { store.setItem(KEY, JSON.stringify(all.slice(0, MAX))); return true; } catch (e) { return false; }   // 滿了或被停用：不擋送出
    }
    // rec: { mode, title, articleId, url, pages:[{ code, label, kind:'now'|'sched', schedule, status, link, error }] }
    function add(rec) {
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const item = Object.assign({ id, at: new Date().toISOString() }, rec);
      save([item].concat(list()));
      return id;
    }
    // 更新某一台的結果（重送）
    function updatePage(id, code, patch) {
      const all = list(), rec = all.find(r => r.id === id);
      if (!rec) return false;
      const p = (rec.pages || []).find(x => x.code === code);
      if (p) Object.assign(p, patch); else (rec.pages = rec.pages || []).push(Object.assign({ code }, patch));
      rec.updatedAt = new Date().toISOString();
      return save(all);
    }
    return { list, add, updatePage, clear: () => { try { store.removeItem(KEY); } catch (e) { /* 無妨 */ } } };
  }

  const api = { KEY, MAX, create };
  if (typeof window !== 'undefined') {
    let ls = null;
    try { ls = window.localStorage; } catch (e) { /* 隱私模式等被停用 */ }
    if (ls) Object.assign(api, create(ls));
    else Object.assign(api, { list: () => [], add: () => '', updatePage: () => false, clear() {} });
  }
  return api;
});
