/** Versioned browser-only script library. Never interpret stored text as HTML. */
export class ScriptLibrary {
  constructor(storage, initial, now = () => Date.now()) {
    this.storage = storage; this.now = now; this.key = 'sufler.library.v1';
    const raw = storage.getItem(this.key);
    this.data = raw ? JSON.parse(raw) : { active: '', scripts: [] };
    if (!Array.isArray(this.data?.scripts)) throw new Error('Повреждена библиотека');
    this.data.scripts = this.data.scripts.filter(s => s && typeof s.id === 'string' && typeof s.text === 'string' && typeof s.title === 'string').map(s => ({ ...s, revisions: Array.isArray(s.revisions) ? s.revisions.filter(r => typeof r.text === 'string' && typeof r.title === 'string').slice(-12) : [] }));
    if (!this.current()) this.create(initial.title, initial.text);
  }
  current() { return this.data.scripts.find(s => s.id === this.data.active && !s.deleted); }
  persist() { this.storage.setItem(this.key, JSON.stringify(this.data)); }
  create(title = 'Новый сценарий', text = '') {
    if (this.data.scripts.length >= 100) throw new Error('В библиотеке уже 100 сценариев. Скачайте резервную копию и удалите ненужные из корзины.');
    const script = { id: globalThis.crypto.randomUUID(), title, text, folder: '', updated: this.now(), revisions: [] };
    this.data.scripts.push(script); this.data.active = script.id; this.persist(); return script;
  }
  update(title, text, folder = '', force = false) {
    const s = this.current(); if (!s) return;
    if (s.text !== text || s.title !== title) {
      if (force || !s.revisions.length || this.now() - s.revisions.at(-1).at >= 30000) {
        s.revisions.push({ text: s.text, title: s.title, at: this.now() }); s.revisions = s.revisions.slice(-12);
      }
    }
    Object.assign(s, { title, text, folder: folder.slice(0, 60), updated: this.now() }); this.persist();
  }
  checkpoint() {
    const s = this.current(); if (!s) return;
    const last = s.revisions.at(-1);
    if (!last || last.text !== s.text || last.title !== s.title) {
      s.revisions.push({ text: s.text, title: s.title, at: this.now() }); s.revisions = s.revisions.slice(-12); this.persist();
    }
  }
  select(id) { const s = this.data.scripts.find(s => s.id === id && !s.deleted); if (!s) return; this.data.active = id; this.persist(); return s; }
  restore(index) { const s = this.current(), revision = s?.revisions[index]; if (!revision) return; this.update(revision.title, revision.text, s.folder, true); return s; }
  archive(id) { const s = this.data.scripts.find(s => s.id === id); if (s) s.deleted = true; this.persist(); }
  recover(id) { const s = this.data.scripts.find(s => s.id === id); if (s) s.deleted = false; this.persist(); }
}
