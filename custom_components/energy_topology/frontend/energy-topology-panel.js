const ESC = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

const TIER_LABEL = (tier) => ({ 1: "Primaire", 2: "Secondaire", 3: "Tertiaire" }[tier] || `Niveau ${tier}`);

class EnergyTopologyPanel extends HTMLElement {
  set hass(value) {
    this._hass = value;
    if (!this._loaded) this._load();
  }

  set panel(value) { this._panel = value; }

  get _isAdmin() { return Boolean(this._hass?.user?.is_admin); }

  connectedCallback() {
    this.innerHTML = `<style>${this._styles()}</style><main><div class="loading">Chargement de la topologie…</div></main>`;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      this._applyView(await this._hass.callWS({ type: "energy_topology/get" }));
      this._loaded = true;
    } catch (err) {
      this.innerHTML = `<style>${this._styles()}</style><main><div class="error">Impossible de lire la topologie (energy_topology/get) : ${ESC(err?.message || err)}</div></main>`;
    } finally {
      this._loading = false;
    }
  }

  _applyView(result) {
    this._nodes = this._indexNodes(result.nodes || []);
    this._issues = result.issues || [];
    this._items = result.items || [];
    this._canUndo = Boolean(result.can_undo);
    this._editing = false;
    this._render();
  }

  // ---- read-only actions --------------------------------------------------

  async _setPanel(id, isPanel) {
    try {
      this._applyView(await this._hass.callWS({
        type: "energy_topology/set_panel", statistic_id: id, is_panel: isPanel,
      }));
    } catch (err) { this._banner(err); }
  }

  async _undo() {
    try {
      this._applyView(await this._hass.callWS({ type: "energy_topology/undo" }));
    } catch (err) { this._banner(err); }
  }

  // ---- edit mode ----------------------------------------------------------

  async _enterEdit() {
    this._editing = true;
    this._draft = (this._items || []).map((it) => ({ ...it }));
    this._preview = null;
    this._render();
    await this._loadCandidates();
    this._render();
  }

  _cancelEdit() {
    this._editing = false;
    this._draft = null;
    this._preview = null;
    this._render();
  }

  async _loadCandidates() {
    try {
      const stats = await this._hass.callWS({ type: "recorder/list_statistic_ids", statistic_type: "sum" });
      this._candidates = (stats || []).filter((s) => s.unit_class === "energy");
    } catch (err) {
      this._candidates = [];
      this._banner(err);
    }
  }

  _draftFind(id) { return (this._draft || []).find((it) => it.stat_consumption === id); }

  _draftSetParent(id, parent) {
    const entry = this._draftFind(id);
    if (!entry) return;
    if (parent) entry.included_in_stat = parent; else delete entry.included_in_stat;
    this._preview = null;
    this._render();
  }

  _draftRemove(id) {
    this._draft = this._draft.filter((it) => it.stat_consumption !== id);
    // Detach children that pointed to the removed node.
    for (const it of this._draft) if (it.included_in_stat === id) delete it.included_in_stat;
    this._preview = null;
    this._render();
  }

  _draftAdd(stat, name, parent) {
    if (!stat || this._draftFind(stat)) return;
    const entry = { stat_consumption: stat };
    if (name) entry.name = name;
    if (parent) entry.included_in_stat = parent;
    this._draft.push(entry);
    this._preview = null;
    this._render();
  }

  async _doPreview() {
    try {
      const result = await this._hass.callWS({
        type: "energy_topology/preview", device_consumption: this._draft,
      });
      this._preview = { issues: result.issues || [] };
      this._render();
    } catch (err) { this._banner(err); }
  }

  async _apply() {
    try {
      const result = await this._hass.callWS({
        type: "energy_topology/save", device_consumption: this._draft,
      });
      this._applyView(result);
    } catch (err) { this._banner(err); }
  }

  _banner(err) {
    const el = this.querySelector("#banner");
    const message = err?.message || err?.error?.message || String(err);
    if (el) el.textContent = `Erreur : ${message}`;
  }

  // ---- helpers ------------------------------------------------------------

  _indexNodes(list) {
    const nodes = new Map();
    for (const item of list) nodes.set(item.id, { ...item, children: [] });
    for (const node of nodes.values()) {
      if (node.parent_id && nodes.has(node.parent_id)) nodes.get(node.parent_id).children.push(node);
    }
    return nodes;
  }

  _roots() {
    return [...this._nodes.values()].filter((n) => !n.parent_id || !this._nodes.has(n.parent_id));
  }

  _label(id) {
    const entry = this._draftFind(id);
    return (entry && entry.name) || (this._nodes?.get(id)?.name) || id;
  }

  _location(node) {
    if (node.floor_name && node.area_name) return `${node.floor_name} · ${node.area_name}`;
    if (node.area_name) return node.area_name;
    if (node.floor_name) return node.floor_name;
    return "non localisé";
  }

  // ---- read-only render ---------------------------------------------------

  _control(node) {
    if (!this._isAdmin || node.has_children) return "";
    if (node.manual_panel) {
      return `<button class="mark active" data-act="mark" data-id="${ESC(node.id)}" data-panel="false" title="Retirer la marque tableau">tableau ✓</button>`;
    }
    return `<button class="mark" data-act="mark" data-id="${ESC(node.id)}" data-panel="true" title="Marquer comme tableau">+ tableau</button>`;
  }

  _renderNode(node, ancestry = new Set()) {
    if (ancestry.has(node.id)) return `<li class="cycle">Cycle vers ${ESC(node.name)}</li>`;
    const next = new Set(ancestry); next.add(node.id);
    const errors = this._issues.filter((i) => i.node === node.id && i.severity === "error").length;
    const badge = errors ? `<span class="badge error-badge">${errors}</span>` : `<span class="badge ok-badge">OK</span>`;
    const children = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
    const link = node.parent_id ? `<span class="parent">inclus dans ${ESC(node.parent_id)}</span>` : `<span class="root">racine</span>`;

    let head;
    if (node.is_panel) {
      const rooms = (node.rooms || []).map((r) => `<span class="chip room">${ESC(r)}</span>`).join("");
      const manual = node.manual_panel && !node.has_children ? `<span class="chip manual">marqué</span>` : "";
      head = `<span class="tier tier-${node.tier}">${ESC(TIER_LABEL(node.tier))}</span><span class="node-name panel-name">${ESC(node.name)}</span><code>${ESC(node.id)}</code>${rooms}${manual}${link}${this._control(node)}${badge}`;
    } else {
      const located = node.area_name || node.floor_name;
      head = `<span class="node-name">${ESC(node.name)}</span><code>${ESC(node.id)}</code><span class="loc ${located ? "" : "loc-none"}">${ESC(this._location(node))}</span>${link}${this._control(node)}${badge}`;
    }

    return `<li class="${node.is_panel ? "is-panel" : ""}">
      <details open><summary>${head}</summary>
      ${children.length ? `<ul>${children.map((c) => this._renderNode(c, next)).join("")}</ul>` : ""}
      </details></li>`;
  }

  _renderView() {
    const nodes = [...this._nodes.values()];
    const roots = this._roots();
    const panels = nodes.filter((n) => n.is_panel).length;
    const located = nodes.filter((n) => n.area_name || n.floor_name).length;
    const errors = this._issues.filter((i) => i.severity === "error");

    const issueBlock = errors.length
      ? `<section class="issues"><h2>Anomalies</h2>${errors.map((i) => `<div class="issue"><span class="pill error">erreur</span><strong>${ESC(i.node)}</strong> — ${ESC(i.message)}</div>`).join("")}</section>`
      : `<section class="success">Aucune boucle, parent absent ni auto-référence détectés.</section>`;

    const actions = this._isAdmin
      ? `<button id="edit">Éditer</button>${this._canUndo ? `<button id="undo" class="ghost">Revenir à l'état précédent</button>` : ""}`
      : "";

    return `
      <header>
        <div><h1>Topologie des tableaux et appareils</h1><p>Vue lecture seule. Les nœuds agrégateurs sont vos <strong>tableaux/zones</strong> (<code>included_in_stat</code>), les pièces sont dérivées du registre.</p></div>
        <div class="actions"><button id="refresh" class="ghost">Actualiser</button>${actions}</div>
      </header>
      <section class="metrics">
        <article><strong>${nodes.length}</strong><span>appareils</span></article>
        <article><strong>${panels}</strong><span>tableaux</span></article>
        <article><strong>${roots.length}</strong><span>racines</span></article>
        <article><strong>${located}/${nodes.length}</strong><span>localisés</span></article>
        <article class="${errors.length ? "metric-error" : ""}"><strong>${errors.length}</strong><span>erreurs</span></article>
      </section>
      <div id="banner" class="banner"></div>
      <section class="toolbar"><input id="search" type="search" placeholder="Rechercher un appareil, un statistic_id, une pièce…"></section>
      ${issueBlock}
      <section class="tree"><ul>${roots.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this._renderNode(r)).join("")}</ul></section>`;
  }

  // ---- edit render --------------------------------------------------------

  _parentOptions(selfId, selected) {
    const opts = [`<option value="">(racine)</option>`];
    for (const it of this._draft) {
      if (it.stat_consumption === selfId) continue;
      opts.push(`<option value="${ESC(it.stat_consumption)}" ${it.stat_consumption === selected ? "selected" : ""}>${ESC(this._label(it.stat_consumption))}</option>`);
    }
    return opts.join("");
  }

  _draftDepth(byId, id) {
    let depth = 1;
    const seen = new Set();
    let current = byId.get(id)?.included_in_stat;
    while (current && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      depth += 1;
      current = byId.get(current).included_in_stat;
    }
    return depth;
  }

  _renderEdit() {
    const tracked = new Set(this._draft.map((it) => it.stat_consumption));
    const candidates = (this._candidates || []).filter((s) => !tracked.has(s.statistic_id));
    const previewErrors = (this._preview?.issues || []).filter((i) => i.severity === "error");
    const previewed = this._preview !== null;

    const byId = new Map(this._draft.map((it) => [it.stat_consumption, it]));
    const parents = new Set(this._draft.map((it) => it.included_in_stat).filter(Boolean));
    const isPanel = (id) => parents.has(id) || Boolean(this._nodes?.get(id)?.manual_panel);

    const rows = this._draft
      .slice()
      .sort((a, b) => {
        const pa = isPanel(a.stat_consumption) ? 0 : 1;
        const pb = isPanel(b.stat_consumption) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if (pa === 0) {
          const da = this._draftDepth(byId, a.stat_consumption);
          const db = this._draftDepth(byId, b.stat_consumption);
          if (da !== db) return da - db;
        }
        return this._label(a.stat_consumption).localeCompare(this._label(b.stat_consumption));
      })
      .map((it) => {
        const panel = isPanel(it.stat_consumption);
        const tag = panel
          ? `<span class="tier tier-${this._draftDepth(byId, it.stat_consumption)}">${ESC(TIER_LABEL(this._draftDepth(byId, it.stat_consumption)))}</span> `
          : "";
        return `
        <tr class="${panel ? "row-panel" : ""}">
          <td>${tag}<strong>${ESC(this._label(it.stat_consumption))}</strong><br><code>${ESC(it.stat_consumption)}</code></td>
          <td><select data-act="parent" data-id="${ESC(it.stat_consumption)}">${this._parentOptions(it.stat_consumption, it.included_in_stat)}</select></td>
          <td><button class="ghost" data-act="remove" data-id="${ESC(it.stat_consumption)}">Retirer</button></td>
        </tr>`;
      }).join("");

    const candOptions = [`<option value="">Choisir une statistique…</option>`]
      .concat(candidates.map((s) => `<option value="${ESC(s.statistic_id)}">${ESC(s.name || s.statistic_id)}</option>`))
      .join("");

    const parentAddOptions = [`<option value="">(racine)</option>`]
      .concat(this._draft.map((it) => `<option value="${ESC(it.stat_consumption)}">${ESC(this._label(it.stat_consumption))}</option>`))
      .join("");

    const previewBlock = !previewed
      ? `<div class="preview none">Prévisualisez pour vérifier le brouillon avant d'appliquer.</div>`
      : previewErrors.length
        ? `<div class="preview error"><strong>${previewErrors.length} erreur(s)</strong> — application bloquée.${previewErrors.map((i) => `<div>${ESC(i.node)} : ${ESC(i.message)}</div>`).join("")}</div>`
        : `<div class="preview ok">Brouillon valide : aucune anomalie structurelle.</div>`;

    const applyDisabled = previewed && previewErrors.length ? "disabled" : "";

    return `
      <header>
        <div><h1>Mode édition</h1><p>Rien n'est écrit tant que vous n'appliquez pas. ${ESC(String(this._draft.length))} appareils dans le brouillon.</p></div>
        <div class="actions">
          <button id="preview" class="ghost">Prévisualiser</button>
          <button id="apply" ${applyDisabled}>Appliquer</button>
          <button id="cancel" class="ghost">Annuler</button>
        </div>
      </header>
      <div id="banner" class="banner"></div>
      ${previewBlock}
      <section class="addbox">
        <h2>Ajouter un appareil</h2>
        <div class="addrow">
          <select id="add-stat">${candOptions}</select>
          <input id="add-name" type="text" placeholder="Nom d'affichage (optionnel)">
          <select id="add-parent">${parentAddOptions}</select>
          <button id="add-btn">Ajouter</button>
        </div>
        <p class="hint">${candidates.length} statistique(s) d'énergie disponible(s) non encore suivie(s).</p>
      </section>
      <section class="editlist">
        <table>
          <thead><tr><th>Appareil</th><th>Rattaché à (tableau parent)</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }

  _render() {
    const body = this._editing ? this._renderEdit() : this._renderView();
    this.innerHTML = `<style>${this._styles()}</style><main>${body}</main>`;
    this._bind();
  }

  _bind() {
    const on = (sel, ev, fn) => { const el = this.querySelector(sel); if (el) el.addEventListener(ev, fn); };

    if (!this._editing) {
      on("#refresh", "click", () => { this._loaded = false; this._load(); });
      on("#edit", "click", () => this._enterEdit());
      on("#undo", "click", () => this._undo());
      on("#search", "input", (e) => this._filter(e.target.value));
      this.querySelectorAll('[data-act="mark"]').forEach((btn) => btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this._setPanel(btn.dataset.id, btn.dataset.panel === "true");
      }));
      return;
    }

    on("#preview", "click", () => this._doPreview());
    on("#apply", "click", () => this._apply());
    on("#cancel", "click", () => this._cancelEdit());
    on("#add-btn", "click", () => {
      const stat = this.querySelector("#add-stat").value;
      const name = this.querySelector("#add-name").value.trim();
      const parent = this.querySelector("#add-parent").value;
      if (!stat) { this._banner({ message: "Choisissez une statistique à ajouter." }); return; }
      this._draftAdd(stat, name, parent);
    });
    this.querySelectorAll('[data-act="parent"]').forEach((sel) => sel.addEventListener("change", (e) => this._draftSetParent(e.target.dataset.id, e.target.value)));
    this.querySelectorAll('[data-act="remove"]').forEach((btn) => btn.addEventListener("click", () => this._draftRemove(btn.dataset.id)));
  }

  _filter(query) {
    const q = query.trim().toLowerCase();
    for (const li of this.querySelectorAll(".tree li")) {
      li.hidden = Boolean(q) && !li.textContent.toLowerCase().includes(q);
    }
  }

  _styles() { return `
    :host{display:block;background:var(--primary-background-color);color:var(--primary-text-color);min-height:100%;font-family:var(--paper-font-body1_-_font-family,system-ui)}
    main{max-width:1200px;margin:auto;padding:24px} header{display:flex;justify-content:space-between;gap:16px;align-items:center} h1{margin:0;font-size:26px} h2{font-size:18px} p{color:var(--secondary-text-color)}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    button,input,select{font:inherit;border:1px solid var(--divider-color);border-radius:10px;padding:9px 13px;background:var(--card-background-color);color:inherit}
    button{cursor:pointer;background:var(--primary-color);color:var(--text-primary-color)}button.ghost{background:var(--card-background-color);color:inherit}button:disabled{opacity:.5;cursor:not-allowed}
    .metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:20px 0}.metrics article{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px;display:flex;flex-direction:column}.metrics strong{font-size:24px}.metrics span{color:var(--secondary-text-color);font-size:13px}
    .metric-error{border-color:var(--error-color)!important}.toolbar input{width:100%;box-sizing:border-box}
    .banner:not(:empty){margin:12px 0;padding:10px 14px;border-radius:10px;border:1px solid var(--error-color);color:var(--error-color)}
    .issues,.success,.tree,.addbox,.editlist,.preview{margin-top:16px;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px}.success{border-color:var(--success-color)}
    .issue{display:flex;align-items:center;gap:8px;padding:4px 0}.pill{font-size:11px;border-radius:999px;padding:2px 8px;text-transform:uppercase}.pill.error{background:rgba(220,50,50,.18);color:var(--error-color)}
    ul{list-style:none;margin:0;padding-left:22px}.tree>ul{padding-left:0}li{margin:6px 0}summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;cursor:pointer;padding:8px;border-radius:8px}summary:hover{background:var(--secondary-background-color)}
    li.is-panel>details>summary{background:var(--secondary-background-color);border:1px solid var(--divider-color)}
    .node-name{font-weight:600}.panel-name{font-weight:700}code{font-size:12px;color:var(--secondary-text-color)}.parent,.root{font-size:12px;color:var(--secondary-text-color)}
    .tier{font-size:11px;font-weight:700;text-transform:uppercase;border-radius:6px;padding:2px 8px;background:var(--primary-color);color:var(--text-primary-color)}.tier-2{background:var(--accent-color,#3f7fd0)}.tier-3{background:var(--state-icon-active-color,#7a52c7)}
    .chip{font-size:12px;border-radius:999px;padding:1px 8px}.chip.room{border:1px solid var(--divider-color);color:var(--secondary-text-color)}.chip.manual{border:1px dashed var(--primary-color);color:var(--primary-color)}
    .loc{font-size:12px;border:1px solid var(--divider-color);border-radius:999px;padding:1px 8px;color:var(--secondary-text-color)}.loc-none{opacity:.6;font-style:italic}
    button.mark{font-size:11px;padding:2px 9px;border-radius:999px;background:transparent;color:var(--secondary-text-color)}button.mark:hover,button.mark.active{border-color:var(--primary-color);color:var(--primary-color)}
    .badge{font-size:11px;border-radius:999px;padding:2px 7px;margin-left:auto}.ok-badge{background:rgba(30,160,90,.15)}.error-badge{background:rgba(220,50,50,.2);color:var(--error-color)}.cycle{color:var(--error-color)}.error{padding:24px;color:var(--error-color)}
    .preview.ok{border-color:var(--success-color)}.preview.error{border-color:var(--error-color);color:var(--error-color)}.preview.none{color:var(--secondary-text-color)}
    .addrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.addrow #add-stat,.addrow #add-name{flex:1;min-width:160px}.hint{font-size:13px;margin:8px 0 0}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--divider-color);vertical-align:top}th{font-size:13px;color:var(--secondary-text-color)}td select{width:100%}tr.row-panel td{background:var(--secondary-background-color)}tr.row-panel td .tier{vertical-align:middle}
    @media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:700px){main{padding:14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}}
  `; }
}
customElements.define("energy-topology-panel", EnergyTopologyPanel);
