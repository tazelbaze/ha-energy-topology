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
    if (this._groupByRoom === undefined) this._groupByRoom = true;
    this._nodes = this._indexNodes(result.nodes || []);
    this._issues = result.issues || [];
    this._items = result.items || [];
    this._canUndo = Boolean(result.can_undo);
    this._editing = false;
    this._quantChecked = false;
    this._quantIssues = [];
    this._coverage = null;
    this._render();
  }

  async _showCoverage() {
    if (!this._candidates) await this._loadCandidates();
    this._coverage = this._computeCoverage();
    this._render();
  }

  _computeCoverage() {
    const tracked = new Set([...(this._nodes?.keys() || [])]);
    const groups = new Map();
    for (const s of (this._candidates || [])) {
      const id = s.statistic_id;
      const area = this._candArea(id);
      if (!area) continue; // per-room coverage only
      const entity = this._hass?.entities?.[id];
      const deviceId = entity?.device_id || `stat:${id}`;
      let group = groups.get(deviceId);
      if (!group) {
        const device = entity?.device_id ? this._hass?.devices?.[entity.device_id] : null;
        const name = (device && (device.name_by_user || device.name)) || s.name || id;
        group = { name, area, covered: false };
        groups.set(deviceId, group);
      }
      if (tracked.has(id)) group.covered = true;
    }
    const byArea = new Map();
    for (const group of groups.values()) {
      if (group.covered) continue;
      if (!byArea.has(group.area)) byArea.set(group.area, []);
      byArea.get(group.area).push(group);
    }
    return byArea;
  }

  async _checkQuantities() {
    const ids = [...(this._nodes?.keys() || [])];
    if (!ids.length) return;
    const start = new Date(Date.now() - 30 * 86400000).toISOString();
    try {
      const stats = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start,
        statistic_ids: ids,
        period: "day",
        types: ["sum"],
      });
      const consumption = {};
      for (const id of ids) {
        const points = stats?.[id];
        if (Array.isArray(points) && points.length >= 2) {
          const first = points[0]?.sum;
          const last = points[points.length - 1]?.sum;
          if (typeof first === "number" && typeof last === "number") consumption[id] = last - first;
        }
      }
      const result = await this._hass.callWS({ type: "energy_topology/check_quantities", consumption });
      this._quantIssues = result.issues || [];
      this._quantChecked = true;
      this._render();
    } catch (err) { this._banner(err); }
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
    this._addFilter = "";
    this._addPeriod = "";
    this._addRoom = "";
    this._render();
    await this._loadCandidates();
    this._render();
  }

  _period(statId) {
    const s = (statId || "").toLowerCase();
    if (/(today|daily|quotidien|journalier|_jour)/.test(s)) return "daily";
    if (/(weekly|hebdo|semaine)/.test(s)) return "weekly";
    if (/(this_month|monthly|mensuel|_mois)/.test(s)) return "monthly";
    if (/(yearly|annuel|_annee|_annuelle|_an\b)/.test(s)) return "yearly";
    return "other";
  }

  _periodLabel(period) {
    return {
      daily: "Journalier", weekly: "Hebdomadaire", monthly: "Mensuel",
      yearly: "Annuel", other: "Autre / total",
    }[period] || period;
  }

  _candArea(statId) {
    const entity = this._hass?.entities?.[statId];
    let areaId = entity?.area_id || null;
    if (!areaId && entity?.device_id) {
      areaId = this._hass?.devices?.[entity.device_id]?.area_id || null;
    }
    const area = areaId ? this._hass?.areas?.[areaId] : null;
    return area ? area.name : null;
  }

  _availableCandidates() {
    const tracked = new Set(this._draft.map((it) => it.stat_consumption));
    const filter = (this._addFilter || "").trim().toLowerCase();
    const period = this._addPeriod || "";
    const room = this._addRoom || "";
    return (this._candidates || [])
      .filter((s) => !tracked.has(s.statistic_id))
      .filter((s) => !period || this._period(s.statistic_id) === period)
      .filter((s) => !room || (this._candArea(s.statistic_id) || "__none__") === room)
      .filter((s) => !filter
        || s.statistic_id.toLowerCase().includes(filter)
        || (s.name || "").toLowerCase().includes(filter));
  }

  _candOptionsHtml(list) {
    return [`<option value="">Choisir une statistique…</option>`]
      .concat(list.slice(0, 200).map((s) => {
        const unit = s.statistics_unit_of_measurement || s.display_unit_of_measurement || "";
        const label = `${s.name || s.statistic_id}${unit ? ` (${unit})` : ""}`;
        return `<option value="${ESC(s.statistic_id)}">${ESC(label)} — ${ESC(s.statistic_id)}</option>`;
      }))
      .join("");
  }

  _refreshCandidates() {
    const sel = this.querySelector("#add-stat");
    const hint = this.querySelector("#add-hint");
    if (!sel) return;
    const list = this._availableCandidates();
    sel.innerHTML = this._candOptionsHtml(list);
    if (hint) {
      const shown = Math.min(list.length, 200);
      hint.textContent = `${list.length} statistique(s) d'énergie disponible(s)${list.length > shown ? `, ${shown} affichées — affinez le filtre` : ""}.`;
    }
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
    // Show the room (area) name only; the floor is a separate axis.
    return node.area_name || node.floor_name || "non localisé";
  }

  _sortNodes(list) {
    // Panels first (by tier), then appliances alphabetically.
    return list.slice().sort((a, b) => {
      const pa = a.is_panel ? 0 : 1;
      const pb = b.is_panel ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (pa === 0 && a.tier !== b.tier) return a.tier - b.tier;
      return a.name.localeCompare(b.name);
    });
  }

  // ---- read-only render ---------------------------------------------------

  _control(node) {
    if (!this._isAdmin) return "";
    if (node.is_panel) {
      return `<button class="mark active" data-act="mark" data-id="${ESC(node.id)}" data-panel="false" title="Ce n'est pas un tableau (appareil parent)">tableau ✓</button>`;
    }
    const title = node.has_children ? "Marquer comme tableau (a des enfants)" : "Marquer comme tableau";
    return `<button class="mark" data-act="mark" data-id="${ESC(node.id)}" data-panel="true" title="${ESC(title)}">+ tableau</button>`;
  }

  _renderChildren(children, ancestry, allowGroup = true) {
    const sorted = this._sortNodes(children);
    if (!this._groupByRoom || !allowGroup) {
      return sorted.map((c) => this._renderNode(c, ancestry)).join("");
    }
    // Sub-panels stay as topology nodes; direct appliances group by room.
    const panels = sorted.filter((c) => c.is_panel);
    const leaves = sorted.filter((c) => !c.is_panel);
    let html = panels.map((c) => this._renderNode(c, ancestry)).join("");
    if (leaves.length) {
      const byRoom = new Map();
      for (const leaf of leaves) {
        const room = leaf.area_name || "Non localisé";
        if (!byRoom.has(room)) byRoom.set(room, []);
        byRoom.get(room).push(leaf);
      }
      const rooms = [...byRoom.keys()].sort((a, b) => (a === "Non localisé" ? 1 : b === "Non localisé" ? -1 : a.localeCompare(b)));
      for (const room of rooms) {
        const items = byRoom.get(room);
        html += `<li class="room-group"><details open><summary><span class="room-head">${ESC(room)}</span><span class="badge ok-badge">${items.length}</span></summary><ul>${items.map((c) => this._renderNode(c, ancestry, { hideLoc: true })).join("")}</ul></details></li>`;
      }
    }
    return html;
  }

  _renderNode(node, ancestry = new Set(), opts = {}) {
    if (ancestry.has(node.id)) return `<li class="cycle">Cycle vers ${ESC(node.name)}</li>`;
    const next = new Set(ancestry); next.add(node.id);
    const errors = this._issues.filter((i) => i.node === node.id && i.severity === "error").length;
    const warns = (this._quantIssues || []).filter((i) => i.node === node.id).length;
    const badge = errors
      ? `<span class="badge error-badge">${errors}</span>`
      : warns
        ? `<span class="badge warn-badge">${warns}</span>`
        : `<span class="badge ok-badge">OK</span>`;
    const link = node.parent_id ? `<span class="parent">inclus dans ${ESC(node.parent_id)}</span>` : `<span class="root">racine</span>`;
    const located = node.area_name || node.floor_name;
    const locChip = opts.hideLoc ? "" : `<span class="loc ${located ? "" : "loc-none"}">${ESC(this._location(node))}</span>`;

    let head;
    if (node.is_panel) {
      const manual = node.manual_panel && !node.has_children ? `<span class="chip manual">marqué</span>` : "";
      head = `<span class="tier tier-${node.tier}">${ESC(TIER_LABEL(node.tier))}</span>${locChip}<span class="node-name panel-name">${ESC(node.name)}</span><code>${ESC(node.id)}</code>${manual}${link}${this._control(node)}${badge}`;
    } else {
      head = `${locChip}<span class="node-name">${ESC(node.name)}</span><code>${ESC(node.id)}</code>${link}${this._control(node)}${badge}`;
    }

    return `<li class="${node.is_panel ? "is-panel" : ""}">
      <details open><summary>${head}</summary>
      ${node.children.length ? `<ul>${this._renderChildren(node.children, next, node.is_panel)}</ul>` : ""}
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

    const actions = `<button id="group" class="ghost">${this._groupByRoom ? "Vue à plat" : "Grouper par pièce"}</button><button id="coverage" class="ghost">Couverture par pièce</button><button id="quant" class="ghost">Vérifier les quantités (30 j)</button>${this._isAdmin ? `<button id="edit">Éditer</button>${this._canUndo ? `<button id="undo" class="ghost">Revenir à l'état précédent</button>` : ""}` : ""}`;

    const coverageBlock = this._coverage
      ? (this._coverage.size
        ? `<section class="issues"><h2>Couverture par pièce — appareils non suivis</h2>${[...this._coverage.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([area, groups]) => `<div class="cov-area"><strong>${ESC(area)}</strong> <span class="badge warn-badge">${groups.length}</span><div class="cov-list">${groups.slice().sort((x, y) => x.name.localeCompare(y.name)).map((g) => `<span class="chip room">${ESC(g.name)}</span>`).join("")}</div></div>`).join("")}<p class="hint">Heuristique : appareils ayant une statistique d'énergie rattachée à une pièce mais absents de la topologie. Un appareil déjà compté en amont dans un tableau peut apparaître ici à tort.</p></section>`
        : `<section class="success">Aucune pièce avec un appareil énergie oublié : la couverture est complète.</section>`)
      : "";

    const quantBlock = this._quantChecked
      ? ((this._quantIssues || []).length
        ? `<section class="issues"><h2>Écarts quantitatifs (30 j)</h2>${this._quantIssues.map((i) => `<div class="issue"><span class="pill warn">alerte</span><strong>${ESC(i.node)}</strong> — ${ESC(i.message)}</div>`).join("")}</section>`
        : `<section class="success">Aucun écart quantitatif sur 30 jours : chaque tableau couvre bien la somme de ses enfants.</section>`)
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
      ${quantBlock}
      ${coverageBlock}
      <section class="tree"><ul>${this._renderChildren(roots, new Set())}</ul></section>`;
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
    const candidates = this._availableCandidates();
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

    const candOptions = this._candOptionsHtml(candidates);

    const trackedSet = new Set(this._draft.map((it) => it.stat_consumption));
    const untracked = (this._candidates || []).filter((s) => !trackedSet.has(s.statistic_id));
    const periodCounts = {};
    for (const s of untracked) {
      const p = this._period(s.statistic_id);
      periodCounts[p] = (periodCounts[p] || 0) + 1;
    }
    const periodOrder = ["daily", "weekly", "monthly", "yearly", "other"];
    const periodOptions = [`<option value="">Toutes les typologies</option>`]
      .concat(periodOrder.filter((p) => periodCounts[p]).map((p) => `<option value="${p}" ${this._addPeriod === p ? "selected" : ""}>${ESC(this._periodLabel(p))} (${periodCounts[p]})</option>`))
      .join("");

    const forRoom = untracked.filter((s) => !this._addPeriod || this._period(s.statistic_id) === this._addPeriod);
    const roomCounts = new Map();
    for (const s of forRoom) {
      const a = this._candArea(s.statistic_id) || "__none__";
      roomCounts.set(a, (roomCounts.get(a) || 0) + 1);
    }
    const roomNames = [...roomCounts.keys()].sort((a, b) => (a === "__none__" ? 1 : b === "__none__" ? -1 : a.localeCompare(b)));
    const roomOptions = [`<option value="">Toutes les pièces</option>`]
      .concat(roomNames.map((n) => `<option value="${ESC(n)}" ${this._addRoom === n ? "selected" : ""}>${n === "__none__" ? "Non localisées" : ESC(n)} (${roomCounts.get(n)})</option>`))
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
        <p class="hint">Choisissez une typologie de statistique (pour rester cohérent), puis une pièce, puis l'entité.</p>
        <div class="addrow filters">
          <label>Typologie<select id="add-period">${periodOptions}</select></label>
          <label>Pièce<select id="add-room">${roomOptions}</select></label>
          <input id="add-search" type="search" placeholder="Filtrer (nom ou statistic_id)…" value="${ESC(this._addFilter || "")}">
        </div>
        <div class="addrow">
          <select id="add-stat">${candOptions}</select>
          <input id="add-name" type="text" placeholder="Nom d'affichage (optionnel)">
          <select id="add-parent">${parentAddOptions}</select>
          <button id="add-btn">Ajouter</button>
        </div>
        <p id="add-hint" class="hint">${candidates.length} statistique(s) correspondante(s)${candidates.length > 200 ? `, 200 affichées — affinez` : ""}.</p>
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
      on("#group", "click", () => { this._groupByRoom = !this._groupByRoom; this._render(); });
      on("#coverage", "click", () => this._showCoverage());
      on("#quant", "click", () => this._checkQuantities());
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
    on("#add-search", "input", (e) => { this._addFilter = e.target.value; this._refreshCandidates(); });
    on("#add-period", "change", (e) => { this._addPeriod = e.target.value; this._addRoom = ""; this._render(); });
    on("#add-room", "change", (e) => { this._addRoom = e.target.value; this._render(); });
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
    .cov-area{padding:8px 0;border-bottom:1px solid var(--divider-color)}.cov-area:last-child{border-bottom:0}.cov-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .issue{display:flex;align-items:center;gap:8px;padding:4px 0}.pill{font-size:11px;border-radius:999px;padding:2px 8px;text-transform:uppercase}.pill.error{background:rgba(220,50,50,.18);color:var(--error-color)}.pill.warn{background:rgba(224,164,0,.2);color:var(--warning-color,#b7860b)}
    ul{list-style:none;margin:0;padding-left:22px}.tree>ul{padding-left:0}li{margin:6px 0}summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;cursor:pointer;padding:8px;border-radius:8px}summary:hover{background:var(--secondary-background-color)}
    li.is-panel>details>summary{background:var(--secondary-background-color);border:1px solid var(--divider-color)}
    li.room-group>details>summary{background:transparent;border:1px dashed var(--divider-color);color:var(--secondary-text-color)}.room-head{font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:.03em}
    .node-name{font-weight:600}.panel-name{font-weight:700}code{font-size:12px;color:var(--secondary-text-color)}.parent,.root{font-size:12px;color:var(--secondary-text-color)}
    .tier{font-size:11px;font-weight:700;text-transform:uppercase;border-radius:6px;padding:2px 8px;background:var(--primary-color);color:var(--text-primary-color)}.tier-2{background:var(--accent-color,#3f7fd0)}.tier-3{background:var(--state-icon-active-color,#7a52c7)}
    .chip{font-size:12px;border-radius:999px;padding:1px 8px}.chip.room{border:1px solid var(--divider-color);color:var(--secondary-text-color)}.chip.manual{border:1px dashed var(--primary-color);color:var(--primary-color)}
    .loc{font-size:12px;border:1px solid var(--divider-color);border-radius:999px;padding:1px 8px;color:var(--secondary-text-color)}.loc-none{opacity:.6;font-style:italic}
    button.mark{font-size:11px;padding:2px 9px;border-radius:999px;background:transparent;color:var(--secondary-text-color)}button.mark:hover,button.mark.active{border-color:var(--primary-color);color:var(--primary-color)}
    .badge{font-size:11px;border-radius:999px;padding:2px 7px;margin-left:auto}.ok-badge{background:rgba(30,160,90,.15)}.warn-badge{background:rgba(224,164,0,.2);color:var(--warning-color,#b7860b)}.error-badge{background:rgba(220,50,50,.2);color:var(--error-color)}.cycle{color:var(--error-color)}.error{padding:24px;color:var(--error-color)}
    .preview.ok{border-color:var(--success-color)}.preview.error{border-color:var(--error-color);color:var(--error-color)}.preview.none{color:var(--secondary-text-color)}
    .addrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.addrow.filters{margin:8px 0 12px}.addrow.filters label{display:flex;flex-direction:column;font-size:12px;color:var(--secondary-text-color);gap:3px}.addrow.filters #add-search{flex:1;min-width:160px;align-self:flex-end}.addrow #add-stat,.addrow #add-name{flex:1;min-width:160px}.hint{font-size:13px;margin:8px 0 0}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--divider-color);vertical-align:top}th{font-size:13px;color:var(--secondary-text-color)}td select{width:100%}tr.row-panel td{background:var(--secondary-background-color)}tr.row-panel td .tier{vertical-align:middle}
    @media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:700px){main{padding:14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}}
  `; }
}
if (!customElements.get("energy-topology-panel")) {
  customElements.define("energy-topology-panel", EnergyTopologyPanel);
}
