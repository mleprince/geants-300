(function(){
  "use strict";

  /* ======================================================================
     1. Modèle d'allure
     ====================================================================== */
  function speedForGradient(g){
    if (g <= -2) return 35;
    if (g < 2) return 25;
    if (g <= 5) return 25 + (g-2)/(5-2) * (12-25);
    if (g <= 9.5) return 12 + (g-5)/(9.5-5) * (8-12);
    const rate = (8-12)/(9.5-5);
    return Math.max(3, 8 + rate*(g-9.5));
  }

  const track = ROUTE.track;
  const N = track.length;
  const seg = [];
  const cumDplusArr = [0], cumDminusArr = [0], cumTimeArr = [0];
  let cumDplus = 0, cumDminus = 0, cumTimeSec = 0;
  for (let i=1;i<N;i++){
    const dKm = track[i].km - track[i-1].km;
    const dEle = track[i].ele - track[i-1].ele;
    const distM = dKm*1000;
    const grad = distM > 0 ? (dEle/distM)*100 : 0;
    const speed = speedForGradient(grad);
    if (dEle>0) cumDplus += dEle; else cumDminus += -dEle;
    cumTimeSec += speed > 0 ? (dKm/speed)*3600 : 0;
    seg.push({grad, speed, distM});
    cumDplusArr.push(cumDplus);
    cumDminusArr.push(cumDminus);
    cumTimeArr.push(cumTimeSec);
  }
  const totalDplus = cumDplus;
  const totalMovingSec = cumTimeSec;
  const totalKm = track[N-1].km;

  function kmToIndex(km){
    let lo=0, hi=N-1;
    while (lo<hi){
      const mid=(lo+hi)>>1;
      if (track[mid].km < km) lo=mid+1; else hi=mid;
    }
    return lo;
  }
  function movingSecAtKm(km){ return cumTimeArr[kmToIndex(km)]; }
  function dplusAtKm(km){ return cumDplusArr[kmToIndex(km)]; }

  const [startH, startM] = ROUTE.meta.startTime.split(":").map(Number);
  const startMinOfDay = startH*60 + startM;

  function fmtHM(sec){
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec/3600), m = Math.round((sec%3600)/60);
    return h + "h" + String(m).padStart(2,"0");
  }
  function fmtClock(sec){
    const totalMin = Math.round(startMinOfDay + sec/60);
    const days = Math.floor(totalMin/1440);
    const mm = totalMin % 1440;
    let s = String(Math.floor(mm/60)).padStart(2,"0") + ":" + String(mm%60).padStart(2,"0");
    if (days>0) s += " +" + days + "j";
    return s;
  }
  function fmtKm(km){ return km.toFixed(1).replace(".", ","); }
  // espace fine insécable entre les milliers : « 6 898 m »
  function fmtInt(n){ return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function esc(s){
    return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  }

  /* ======================================================================
     2. Catalogue des points d'intérêt
     ====================================================================== */
  const GROUPS = {
    water: {label:"Eau",       color:"var(--t-water)", icon:"💧", on:true},
    bread: {label:"Pain",      color:"var(--t-bread)", icon:"🥖", on:true},
    shop:  {label:"Épicerie",  color:"var(--t-shop)",  icon:"🛒", on:true},
    cem:   {label:"Cimetière", color:"var(--t-cem)",   icon:"✚",  on:false}
  };
  const TYPE_GROUP = {
    drinking_water:"water", fountain:"water",
    bakery:"bread",
    convenience:"shop", supermarket:"shop",
    cemetery:"cem"
  };
  const TYPE_LABEL = {
    drinking_water:"Point d'eau", fountain:"Fontaine", bakery:"Boulangerie",
    convenience:"Épicerie", supermarket:"Supermarché", cemetery:"Cimetière", col:"Col"
  };

  const points = [];
  ROUTE.cols.forEach(c=>{
    points.push({
      id:"col:"+c.name, kind:"col", group:"col", type:"col",
      name:c.name, km:c.km, ele:c.ele, lat:c.lat, lon:c.lon,
      estimated:!!c.estimated, color:"var(--t-col)", icon:"▲"
    });
  });
  ROUTE.pois.forEach((p,i)=>{
    const group = TYPE_GROUP[p.type] || "shop";
    // OSM laisse le nom générique en minuscules (« eau potable ») quand le
    // point n'a pas de nom propre : on lui préfère l'intitulé du type.
    const named = p.name && p.name !== p.label;
    points.push({
      id:"poi:"+i, kind:"poi", group, type:p.type,
      name: named ? p.name : (TYPE_LABEL[p.type] || p.label || "Point"),
      km:p.km, ele:track[kmToIndex(p.km)].ele, lat:p.lat, lon:p.lon,
      color:GROUPS[group].color, icon:GROUPS[group].icon
    });
  });
  points.sort((a,b)=>a.km-b.km);
  const pointById = new Map(points.map(p=>[p.id, p]));

  /* ======================================================================
     3. État
     ====================================================================== */
  let pauses = [];
  let cursorKm = 0;
  let activeView = "carte";
  let plotScope = "all";
  let sheetFull = false;
  const filters = new Set(Object.keys(GROUPS).filter(k=>GROUPS[k].on));

  function pauseKey(p){ return p.key || ("km:"+p.km.toFixed(2)); }
  function pauseSecBeforeKm(km){
    let s=0;
    for (const p of pauses) if (p.km <= km) s += p.min*60;
    return s;
  }
  function totalPauseSec(){ return pauses.reduce((a,p)=>a+p.min*60, 0); }
  function etaAtKm(km){ return movingSecAtKm(km) + pauseSecBeforeKm(km); }
  function finishSec(){ return totalMovingSec + totalPauseSec(); }

  function visiblePoints(){
    return points.filter(p => p.kind === "col" || filters.has(p.group));
  }
  function pointsAhead(limit){
    const out = [];
    for (const p of visiblePoints()){
      if (p.km >= cursorKm - 0.05){
        out.push(p);
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }
  function nextCol(){
    return points.find(p => p.kind === "col" && p.km > cursorKm + 0.2) || null;
  }

  /* ======================================================================
     4. Tracé du profil (SVG + repères HTML)
     ====================================================================== */
  function gradColor(g){
    if (g <= -2) return "var(--descent)";
    if (g < 2)   return "var(--flat)";
    if (g <= 9.5) return "var(--climb-mod)";
    return "var(--climb-steep)";
  }

  // Échantillonne le tracé sur [kmFrom,kmTo] en ~targetPts points,
  // avec la pente moyenne de chaque pas (moins bruitée qu'au 0,1 km).
  function sampleRange(kmFrom, kmTo, targetPts){
    const iFrom = kmToIndex(kmFrom), iTo = kmToIndex(kmTo);
    const span = Math.max(1, iTo - iFrom);
    const step = Math.max(1, Math.floor(span/targetPts));
    const pts = [];
    for (let i=iFrom; i<=iTo; i+=step) pts.push(track[i]);
    if (pts[pts.length-1] !== track[iTo]) pts.push(track[iTo]);
    const grads = [];
    for (let k=1;k<pts.length;k++){
      const dM = (pts[k].km - pts[k-1].km)*1000;
      grads.push(dM > 0 ? (pts[k].ele - pts[k-1].ele)/dM*100 : 0);
    }
    return {pts, grads};
  }

  /**
   * La pente change de catégorie tous les 2–3 pas sur une route de montagne,
   * ce qui donne un profil rayé illisible. On absorbe donc toute plage de
   * couleur plus courte que `minRunKm` dans sa voisine, jusqu'à stabilisation
   * (chaque passe réduit strictement le nombre de plages, donc ça termine).
   */
  function smoothColors(pts, grads, minRunKm){
    const colors = grads.map(gradColor);
    let changed = true;
    while (changed){
      changed = false;
      let i = 0;
      while (i < colors.length){
        let j = i;
        while (j < colors.length && colors[j] === colors[i]) j++;
        if (pts[j].km - pts[i].km < minRunKm && !(i === 0 && j === colors.length)){
          const fill = i > 0 ? colors[i-1] : colors[j];
          for (let k=i; k<j; k++) colors[k] = fill;
          changed = true;
        }
        i = j;
      }
    }
    return colors;
  }

  let plotSeq = 0;

  /**
   * Dessine un profil dans `container` et mémorise sa géométrie sur
   * container._plot pour que le curseur puisse bouger sans tout redessiner.
   * opts : {kmFrom, kmTo, topPct, pts, colLabels, poiMarks, pauseMarks}
   */
  function buildPlot(container, opts){
    const kmFrom = opts.kmFrom, kmTo = opts.kmTo;
    const topPct = opts.topPct || 0;
    const {pts, grads} = sampleRange(kmFrom, kmTo, opts.pts || 400);

    let minEle = Infinity, maxEle = -Infinity;
    for (const p of pts){
      if (p.ele < minEle) minEle = p.ele;
      if (p.ele > maxEle) maxEle = p.ele;
    }
    const eleSpan = Math.max(1, maxEle - minEle);
    const kmSpan = Math.max(0.001, kmTo - kmFrom);

    const xOf = km => (km - kmFrom)/kmSpan * 100;
    const yOf = ele => topPct + (1 - (ele - minEle)/eleSpan) * (100 - topPct);

    // silhouette fermée en bas, servant de masque
    let d = "M0,100";
    for (const p of pts) d += " L" + xOf(p.km).toFixed(3) + "," + yOf(p.ele).toFixed(3);
    d += " L100,100 Z";

    // aplats de couleur par pente, regroupés en séries
    const colors = smoothColors(pts, grads, kmSpan/70);
    let rects = "";
    let k = 0;
    while (k < colors.length){
      const color = colors[k];
      let j = k;
      while (j < colors.length && colors[j] === color) j++;
      const x1 = xOf(pts[k].km), x2 = xOf(pts[j].km);
      rects += '<rect x="'+x1.toFixed(3)+'" y="0" width="'+Math.max(0.01,(x2-x1)).toFixed(3)+
               '" height="100" fill="'+color+'"/>';
      k = j;
    }

    const cid = "plotclip-" + (++plotSeq);
    let html =
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><clipPath id="'+cid+'" clipPathUnits="userSpaceOnUse">' +
          '<path d="'+d+'"/></clipPath></defs>' +
        '<g clip-path="url(#'+cid+')">'+rects+'</g>' +
      '</svg>';

    // cols
    for (const p of points){
      if (p.kind !== "col" || p.km < kmFrom || p.km > kmTo) continue;
      html += '<span class="mk-col" style="left:'+xOf(p.km).toFixed(2)+'%"></span>';
    }
    // pauses
    if (opts.pauseMarks){
      for (const p of pauses){
        if (p.km < kmFrom || p.km > kmTo) continue;
        html += '<span class="mk-pause" style="left:'+xOf(p.km).toFixed(2)+'%"></span>';
      }
    }
    // ravitos
    if (opts.poiMarks){
      for (const p of opts.poiMarks){
        if (p.km < kmFrom || p.km > kmTo) continue;
        html += '<span class="mk-poi" style="left:'+xOf(p.km).toFixed(2)+'%;top:'+
                yOf(p.ele).toFixed(2)+'%;background:'+p.color+'"></span>';
      }
    }
    // étiquettes de cols
    if (opts.colLabels){
      let lane = 0;
      for (const p of points){
        if (p.kind !== "col" || p.km < kmFrom || p.km > kmTo) continue;
        const top = Math.max(1, yOf(p.ele) - 8 - (lane%2)*7);
        lane++;
        html += '<span class="pv-lbl" style="left:'+xOf(p.km).toFixed(2)+'%;top:'+top.toFixed(2)+
                '%">'+esc(shortColName(p.name))+'</span>';
      }
    }
    // curseur
    html += '<span class="mk-you" style="left:0%;top:0%"></span>';

    container.innerHTML = html;
    container._plot = {
      kmFrom, kmTo, topPct, minEle, eleSpan,
      cursorEl: container.querySelector(".mk-you"),
      xOf, yOf
    };
    positionCursor(container);
  }

  function positionCursor(container){
    const g = container._plot;
    if (!g || !g.cursorEl) return;
    const inRange = cursorKm >= g.kmFrom && cursorKm <= g.kmTo;
    g.cursorEl.style.display = inRange ? "" : "none";
    if (!inRange) return;
    const ele = track[kmToIndex(cursorKm)].ele;
    g.cursorEl.style.left = g.xOf(cursorKm).toFixed(2) + "%";
    g.cursorEl.style.top  = g.yOf(ele).toFixed(2) + "%";
  }

  function shortColName(name){
    return name.replace(/^Col des /,"").replace(/^Col de la /,"").replace(/^Col de /,"")
               .replace(/^Col du /,"").replace(/^Golet à /,"").replace(/^Sommet du /,"");
  }

  /* ======================================================================
     5. Bandeau profil (vue Carte)
     ====================================================================== */
  const stripPlot = document.getElementById("strip-plot");

  function renderStrip(){
    buildPlot(stripPlot, {
      kmFrom:0, kmTo:totalKm, topPct:6, pts:300,
      poiMarks: pointsAhead(14).filter(p=>p.kind==="poi"),
      pauseMarks:true
    });
    const restKm = Math.max(0, totalKm - cursorKm);
    const restDplus = Math.max(0, totalDplus - dplusAtKm(cursorKm));
    document.getElementById("strip-val").textContent =
      "reste " + fmtKm(restKm) + " km · " + fmtInt(restDplus) + " m D+";
    document.getElementById("strip-ax-r").textContent = fmtKm(totalKm) + " km";
    document.getElementById("strip-ax-c").textContent =
      cursorKm > 0.2 ? "repère · " + Math.round(cursorKm) : "";
  }

  /* ======================================================================
     6. Grand profil (vue Profil)
     ====================================================================== */
  const pvPlot = document.getElementById("pv-plot");

  function scopeRange(){
    if (plotScope === "ahead") return {from: cursorKm, to: totalKm};
    if (plotScope === "col"){
      const c = nextCol();
      if (c) return {from: Math.max(0, cursorKm - 2), to: Math.min(totalKm, c.km + 8)};
    }
    return {from: 0, to: totalKm};
  }

  function renderBigPlot(){
    const r = scopeRange();
    if (r.to - r.from < 1) r.to = Math.min(totalKm, r.from + 1);
    buildPlot(pvPlot, {
      kmFrom:r.from, kmTo:r.to, topPct:14, pts:600,
      colLabels:true, pauseMarks:true,
      poiMarks: visiblePoints().filter(p=>p.kind==="poi" && p.km>=r.from && p.km<=r.to)
    });
    document.getElementById("pv-meta").textContent =
      fmtKm(totalKm) + " km · " + fmtInt(totalDplus) + " m D+";
  }

  function renderCursorList(){
    const list = document.getElementById("pv-cursor-list");
    const title = document.getElementById("pv-cursor-title");
    const hint = document.getElementById("pv-cursor-hint");
    const idx = kmToIndex(cursorKm);
    const g = idx > 0 ? seg[idx-1].grad : 0;

    title.textContent = "Km " + fmtKm(cursorKm) + " · " + fmtInt(track[idx].ele) + " m";
    hint.textContent = "pente " + g.toFixed(1).replace(".",",") + " % · " +
                       fmtClock(etaAtKm(cursorKm));

    const near = visiblePoints()
      .filter(p => p.km >= cursorKm - 0.05)
      .slice(0, 6);
    list.innerHTML = near.length
      ? near.map(p=>poiRowHtml(p)).join("")
      : '<p class="empty">Rien devant ce repère.</p>';
    wirePoiRows(list);
  }

  /* ======================================================================
     7. Liste des ravitaillements (vue Carte)
     ====================================================================== */
  function hoursBadge(p){
    if (p.kind === "col") return "";
    if (p.group === "water") return '<span class="hrs ok">Accessible 24 h/24</span>';
    return '<span class="hrs unk">Horaires non renseignés</span>';
  }

  function poiRowHtml(p){
    const dist = p.km - cursorKm;
    const sub = p.kind === "col"
      ? fmtInt(p.ele) + " m · D+ " + fmtInt(dplusAtKm(p.km)) + " m"
      : (TYPE_LABEL[p.type] || "Point") + " · km " + fmtKm(p.km);
    return '<button class="poi" type="button" data-id="'+esc(p.id)+'">' +
availableIcon(p) +
      '<span><span class="nm">'+esc(p.name)+'</span>' +
      '<span class="sub"><span>'+esc(sub)+'</span>'+hoursBadge(p)+'</span></span>' +
      '<span class="dist"><b>'+(dist < 0 ? "0" : fmtKm(dist))+'</b><i>'+fmtClock(etaAtKm(p.km))+'</i></span>' +
      '</button>';
  }
  function availableIcon(p){
    return '<span class="ic" style="background:'+p.color+'">'+p.icon+'</span>';
  }

  function wirePoiRows(root){
    root.querySelectorAll(".poi").forEach(btn=>{
      btn.addEventListener("click", ()=>openPoiCard(btn.dataset.id));
    });
  }

  function renderPoiList(){
    const list = document.getElementById("poi-list");
    const ahead = pointsAhead(60);
    if (!ahead.length){
      list.innerHTML = '<p class="empty">Aucun point devant vous avec ces filtres.</p>';
      return;
    }
    const buckets = [
      {label:"Dans les 10 km", max:10, rows:[]},
      {label:"10 à 50 km",     max:50, rows:[]},
      {label:"Plus loin",      max:Infinity, rows:[]}
    ];
    for (const p of ahead){
      const d = p.km - cursorKm;
      (buckets.find(b => d <= b.max) || buckets[2]).rows.push(p);
    }
    let html = "";
    for (const b of buckets){
      if (!b.rows.length) continue;
      html += '<div class="grp"><span>'+b.label+'</span><span>'+b.rows.length+'</span></div>';
      html += b.rows.map(poiRowHtml).join("");
    }
    list.innerHTML = html;
    wirePoiRows(list);
  }

  function renderFilters(){
    const wrap = document.getElementById("poi-filters");
    wrap.innerHTML = Object.keys(GROUPS).map(k=>
      '<button class="chip" type="button" data-group="'+k+'" aria-pressed="'+filters.has(k)+'">' +
      '<span class="d" style="background:'+GROUPS[k].color+'"></span>'+GROUPS[k].label+'</button>'
    ).join("");
    wrap.querySelectorAll(".chip").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const g = btn.dataset.group;
        if (filters.has(g)) filters.delete(g); else filters.add(g);
        btn.setAttribute("aria-pressed", filters.has(g));
        applyMapFilters();
        renderPoiList();
        renderStrip();
        if (activeView === "profil") renderBigPlot();
      });
    });
  }

  /* ======================================================================
     8. Fiche d'un point
     ====================================================================== */
  const overlay = document.getElementById("poi-overlay");
  let cardPoint = null;

  function openPoiCard(id){
    const p = pointById.get(id);
    if (!p) return;
    cardPoint = p;
    const dist = Math.max(0, p.km - cursorKm);
    const dplus = Math.max(0, dplusAtKm(p.km) - dplusAtKm(cursorKm));
    const ic = document.getElementById("poi-card-ic");
    ic.textContent = p.icon;
    ic.style.background = p.color;
    document.getElementById("poi-card-type").textContent =
      (TYPE_LABEL[p.type] || "Point") + " · km " + fmtKm(p.km);
    document.getElementById("poi-card-title").textContent = p.name;
    document.getElementById("poi-card-adr").textContent = p.kind === "col"
      ? fmtInt(p.ele) + " m d'altitude" + (p.estimated ? " · position estimée" : "")
      : "Altitude " + fmtInt(p.ele) + " m";
    document.getElementById("poi-card-dist").textContent = fmtKm(dist) + " km";
    document.getElementById("poi-card-eta").textContent = fmtClock(etaAtKm(p.km));
    document.getElementById("poi-card-dplus").textContent = "+" + fmtInt(dplus) + " m";
    document.getElementById("poi-card-note").textContent = p.group === "water"
      ? "Point d'eau relevé dans OpenStreetMap, accessible en permanence. À vérifier sur place : certaines fontaines sont coupées hors saison."
      : "Les horaires d'ouverture ne sont pas encore dans les données du parcours. Vérifiez avant de compter dessus.";
    overlay.classList.add("is-open");
    document.getElementById("poi-card-close").focus();
  }
  function closePoiCard(){
    overlay.classList.remove("is-open");
    cardPoint = null;
  }
  document.getElementById("poi-card-close").addEventListener("click", closePoiCard);
  overlay.addEventListener("click", e=>{ if (e.target === overlay) closePoiCard(); });
  document.addEventListener("keydown", e=>{ if (e.key === "Escape") closePoiCard(); });
  document.getElementById("poi-card-pause").addEventListener("click", ()=>{
    if (!cardPoint) return;
    addPause({km:cardPoint.km, min:15, label:cardPoint.name});
    closePoiCard();
    setView("pauses");
  });

  /* ======================================================================
     9. Pauses
     ====================================================================== */
  function buildSuggestions(){
    const sugg = [];
    const MAJOR_ELE = 1400;
    ROUTE.cols.forEach(c=>{
      const major = c.ele >= MAJOR_ELE;
      sugg.push({
        key:"col:"+c.name, km:c.km, min: major ? 18 : 8,
        label: shortColName(c.name)
      });
    });
    const markers = [0].concat(ROUTE.cols.map(c=>c.km)).concat([totalKm]).sort((a,b)=>a-b);
    for (let i=0;i<markers.length-1;i++){
      const gap = markers[i+1]-markers[i];
      if (gap > 45){
        const mid = markers[i] + gap/2;
        // On accroche la pause à un vrai ravitaillement : commerces d'abord,
        // eau à défaut. Sans ce filtre, un cimetière peut « gagner ».
        let best = null, bestD = 6;
        for (const rank of [["bread","shop"], ["water"]]){
          points.forEach(p=>{
            if (p.kind !== "poi" || !rank.includes(p.group)) return;
            const d = Math.abs(p.km - mid);
            if (d < bestD){ bestD = d; best = p; }
          });
          if (best) break;
        }
        sugg.push({
          key:"gap:"+i, km: best ? best.km : mid, min:20,
          label: best ? best.name : "Long tronçon"
        });
      }
    }
    const duskMin = 21*60+30;
    for (let k=0;k<N;k++){
      if ((startMinOfDay + cumTimeArr[k]/60) % 1440 >= duskMin){
        const km = track[k].km;
        if (!sugg.some(s=>Math.abs(s.km-km)<8) && km < totalKm-5){
          sugg.push({key:"dusk", km, min:20, label:"Tombée de la nuit"});
        }
        break;
      }
    }
    sugg.sort((a,b)=>a.km-b.km);
    return sugg;
  }
  const suggestions = buildSuggestions();

  function addPause(p){
    if (!pauses.some(x=>pauseKey(x) === pauseKey(p))) pauses.push(p);
    recompute();
  }

  function renderSuggestions(){
    const wrap = document.getElementById("suggest-list");
    wrap.innerHTML = suggestions.map(s=>{
      const on = pauses.some(p=>p.key === s.key);
      return '<button type="button" data-key="'+esc(s.key)+'" aria-pressed="'+on+'">' +
             esc(s.label) + ' · km ' + Math.round(s.km) + '</button>';
    }).join("");
    wrap.querySelectorAll("button").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const s = suggestions.find(x=>x.key === btn.dataset.key);
        const i = pauses.findIndex(p=>p.key === s.key);
        if (i >= 0) pauses.splice(i,1);
        else pauses.push({km:s.km, min:s.min, label:s.label, key:s.key});
        recompute();
      });
    });
  }

  function renderPauses(){
    const list = document.getElementById("pause-list");
    if (!pauses.length){
      list.innerHTML = '<p class="empty">Aucune pause planifiée.</p>';
      return;
    }
    const sorted = pauses.slice().sort((a,b)=>a.km-b.km);
    list.innerHTML = sorted.map((p,i)=>
      '<div class="prow" data-i="'+i+'">' +
        '<span><span class="nm">'+esc(p.label || "Pause")+'</span>' +
        '<span class="sub">km '+fmtKm(p.km)+' · reprise '+fmtClock(etaAtKm(p.km))+'</span></span>' +
        '<span class="step">' +
          '<button type="button" data-act="minus" aria-label="Retirer 5 minutes">−</button>' +
          '<b>'+p.min+'′</b>' +
          '<button type="button" data-act="plus" aria-label="Ajouter 5 minutes">+</button>' +
        '</span>' +
        '<button class="rm" type="button" data-act="rm" aria-label="Supprimer la pause">×</button>' +
      '</div>'
    ).join("");
    list.querySelectorAll(".prow").forEach(row=>{
      const p = sorted[Number(row.dataset.i)];
      row.querySelectorAll("button").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          const act = btn.dataset.act;
          if (act === "rm") pauses = pauses.filter(x=>x !== p);
          else if (act === "plus") p.min = Math.min(600, p.min + 5);
          else p.min = Math.max(5, p.min - 5);
          recompute();
        });
      });
    });
  }

  document.getElementById("add-pause").addEventListener("click", ()=>{
    const kmI = document.getElementById("pause-km");
    const minI = document.getElementById("pause-min");
    const lblI = document.getElementById("pause-label");
    const km = parseFloat(kmI.value);
    const min = parseInt(minI.value, 10);
    const kmBad = isNaN(km) || km < 0 || km > totalKm;
    const minBad = isNaN(min) || min <= 0;
    kmI.classList.toggle("invalid", kmBad);
    minI.classList.toggle("invalid", minBad);
    if (kmBad || minBad) return;
    pauses.push({km, min, label: lblI.value.trim() || "Pause"});
    kmI.value = ""; minI.value = ""; lblI.value = "";
    recompute();
  });

  /* ======================================================================
     10. Tableaux (vue Plan)
     ====================================================================== */
  function renderWaypoints(){
    const body = document.getElementById("waypoints-body");
    const rows = [{name:"Départ", km:0, ele:track[0].ele}]
      .concat(ROUTE.cols.map(c=>({name:c.name, km:c.km, ele:c.ele, estimated:c.estimated})))
      .concat([{name:"Arrivée", km:totalKm, ele:track[N-1].ele}]);
    body.innerHTML = rows.map(p=>{
      const moving = movingSecAtKm(p.km), ps = pauseSecBeforeKm(p.km);
      return '<tr data-km="'+p.km+'">' +
        '<td class="name">'+esc(p.name)+(p.estimated?'<span class="badge-est">estimé</span>':'')+'</td>' +
        '<td>'+fmtKm(p.km)+'</td><td>'+fmtInt(p.ele)+' m</td>' +
        '<td>+'+fmtInt(dplusAtKm(p.km))+' m</td>' +
        '<td>'+fmtHM(moving)+'</td><td>'+(ps>0?fmtHM(ps):"—")+'</td>' +
        '<td>'+fmtClock(moving+ps)+'</td></tr>';
    }).join("");
    body.querySelectorAll("tr").forEach(tr=>{
      tr.addEventListener("click", ()=>{
        document.getElementById("pause-km").value = Number(tr.dataset.km).toFixed(1);
        setView("pauses");
        document.getElementById("pause-min").focus();
      });
    });
    document.getElementById("plan-meta").textContent =
      fmtKm(totalKm) + " km · " + fmtInt(totalDplus) + " m D+";
  }

  function renderSplits(){
    const body = document.getElementById("splits-body");
    const stepKm = 10;
    let prevDplus = 0, prevDminus = 0, html = "";
    for (let km=stepKm; km<=Math.ceil(totalKm/stepKm)*stepKm; km+=stepKm){
      const kkm = Math.min(km, totalKm);
      const dplus = dplusAtKm(kkm), dminus = cumDminusArr[kmToIndex(kkm)];
      const segDplus = dplus-prevDplus, segDminus = dminus-prevDminus;
      const avgGrad = ((segDplus-segDminus)/(stepKm*1000))*100;
      const moving = movingSecAtKm(kkm);
      html += '<tr><td class="name">'+kkm.toFixed(0)+'</td>' +
        '<td>+'+fmtInt(segDplus)+' m</td><td>−'+fmtInt(segDminus)+' m</td>' +
        '<td>+'+fmtInt(dplus)+' m</td>' +
        '<td>'+(avgGrad>=0?"+":"")+avgGrad.toFixed(1).replace(".",",")+' %</td>' +
        '<td>'+fmtHM(moving)+'</td><td>'+fmtClock(moving+pauseSecBeforeKm(kkm))+'</td></tr>';
      prevDplus = dplus; prevDminus = dminus;
      if (kkm >= totalKm) break;
    }
    body.innerHTML = html;
  }

  /* ======================================================================
     11. Carte Leaflet
     ====================================================================== */
  let map = null, cursorMarker = null;
  const groupLayers = {};
  const allMarkers = [];
  let routeBounds = null;

  function radiusForZoom(isCol){
    const z = map ? map.getZoom() : 10;
    if (z >= 13) return isCol ? 8 : 6;
    if (z >= 11) return isCol ? 6 : 4;
    return isCol ? 5 : 3;
  }
  function resizeMarkers(){
    allMarkers.forEach(m=>m.setRadius(radiusForZoom(m._isCol)));
  }

  function cssVar(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function resolve(color){
    const m = /^var\((--[\w-]+)\)$/.exec(color);
    return m ? (cssVar(m[1]) || "#888") : color;
  }

  function buildMap(){
    map = L.map("leaflet-map", {zoomControl:false, attributionControl:true});
    L.control.zoom({position:"bottomleft"}).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom:18,
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    // Tracé d'une seule couleur. Le pas est réduit à 500 m (5 × 100 m) : au pas
    // natif la polyligne compte des milliers de points et fige la carte sur
    // téléphone.
    const STEP = 5; // 5 × 100 m
    const latlngs = [];
    for (let i=0; i<N; i+=STEP) latlngs.push([track[i].lat, track[i].lon]);
    latlngs.push([track[N-1].lat, track[N-1].lon]);
    L.polyline(latlngs, {
      color: resolve("var(--accent)"), weight:4, opacity:.95,
      lineCap:"round", lineJoin:"round"
    }).addTo(map);

    // couches par groupe
    Object.keys(GROUPS).forEach(g=>{ groupLayers[g] = L.layerGroup(); });
    groupLayers.col = L.layerGroup().addTo(map);

    points.forEach(p=>{
      if (p.lat == null || p.lon == null) return;
      const isCol = p.kind === "col";
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: radiusForZoom(isCol),
        color: isCol ? "#ffffff" : resolve("var(--surface)"),
        weight: 2,
        fillColor: resolve(p.color),
        fillOpacity: 1
      });
      marker._isCol = isCol;
      marker.on("click", ()=>openPoiCard(p.id));
      marker.bindTooltip(p.name, {direction:"top", offset:[0,-6]});
      marker.addTo(groupLayers[isCol ? "col" : p.group]);
      allMarkers.push(marker);
    });

    // Dézoomé sur 300 km, 198 pastilles de 6 px se recouvrent en amas
    // illisibles : on les rétrécit tant qu'on ne regarde pas une vallée.
    map.on("zoomend", resizeMarkers);
    resizeMarkers();

    L.circleMarker([track[0].lat, track[0].lon], {
      radius:6, color:"#fff", weight:2,
      fillColor:resolve("var(--ink)"), fillOpacity:1
    }).bindTooltip("Départ / Arrivée").addTo(map);

    applyMapFilters();

    routeBounds = L.latLngBounds(track.map(p=>[p.lat, p.lon]));
    fitRoute();
    requestAnimationFrame(fitRoute);

    map.on("click", e=>{
      setCursorKm(nearestKmToLatLng(e.latlng.lat, e.latlng.lng));
    });

    let t = null;
    window.addEventListener("resize", ()=>{
      clearTimeout(t);
      t = setTimeout(()=>map.invalidateSize(), 150);
    });
  }

  function fitRoute(){
    if (!map || !routeBounds) return;
    map.invalidateSize();
    map.fitBounds(routeBounds, {paddingTopLeft:[10,54], paddingBottomRight:[10,14]});
  }

  function applyMapFilters(){
    if (!map) return;
    Object.keys(GROUPS).forEach(g=>{
      const layer = groupLayers[g];
      if (filters.has(g)) layer.addTo(map);
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function nearestKmToLatLng(lat, lon){
    let bestIdx = 0, bestD = Infinity;
    const cosLat = Math.cos(lat*Math.PI/180);
    for (let i=0;i<N;i++){
      const dLat = track[i].lat - lat;
      const dLon = (track[i].lon - lon)*cosLat;
      const d = dLat*dLat + dLon*dLon;
      if (d < bestD){ bestD = d; bestIdx = i; }
    }
    return track[bestIdx].km;
  }

  function updateMapCursor(live){
    if (!map) return;
    const p = track[kmToIndex(cursorKm)];
    const latlng = [p.lat, p.lon];
    if (!cursorMarker){
      cursorMarker = L.marker(latlng, {
        icon: L.divIcon({className:"cursor-dot", iconSize:[14,14], iconAnchor:[7,7]}),
        interactive:false, zIndexOffset:900
      }).addTo(map);
    } else {
      cursorMarker.setLatLng(latlng);
    }
    // en balayage, on suit le repère s'il sort du cadre (marge de 12 %)
    if (live && activeView === "carte" && !map.getBounds().pad(-0.12).contains(latlng)){
      map.panTo(latlng, {animate:false});
    }
  }

  /* ======================================================================
     12. Géolocalisation
     ====================================================================== */
  let geoWatchId = null, geoMarker = null, geoCircle = null;

  function onGeoPosition(pos){
    const {latitude, longitude, accuracy} = pos.coords;
    const latlng = [latitude, longitude];
    if (!geoMarker){
      geoMarker = L.marker(latlng, {
        icon: L.divIcon({className:"geoloc-dot", iconSize:[16,16], iconAnchor:[8,8]}),
        interactive:false, zIndexOffset:1000
      }).addTo(map);
      geoCircle = L.circle(latlng, {
        radius:accuracy, color:"#2f7dd1", weight:1,
        fillColor:"#2f7dd1", fillOpacity:.12, interactive:false
      }).addTo(map);
      map.setView(latlng, Math.max(map.getZoom(), 13));
    } else {
      geoMarker.setLatLng(latlng);
      geoCircle.setLatLng(latlng).setRadius(accuracy);
    }
    setCursorKm(nearestKmToLatLng(latitude, longitude));
  }

  function stopGeolocation(){
    if (geoWatchId != null){ navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    const btn = document.getElementById("geoloc-toggle");
    btn.classList.remove("active");
    btn.title = "Afficher ma position";
    if (geoMarker) { map.removeLayer(geoMarker); geoMarker = null; }
    if (geoCircle) { map.removeLayer(geoCircle); geoCircle = null; }
  }

  document.getElementById("geoloc-toggle").addEventListener("click", ()=>{
    if (geoWatchId != null){ stopGeolocation(); return; }
    if (!navigator.geolocation){
      alert("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    const btn = document.getElementById("geoloc-toggle");
    btn.classList.add("active");
    btn.title = "Suivi en cours — appuyer pour arrêter";
    geoWatchId = navigator.geolocation.watchPosition(
      onGeoPosition,
      err=>{ stopGeolocation(); alert("Position indisponible : " + err.message); },
      {enableHighAccuracy:true, maximumAge:5000, timeout:15000}
    );
  });

  /* ======================================================================
     13. Curseur partagé
     ====================================================================== */
  /* Pendant un balayage au doigt, la partie « légère » (repères, entête,
     marqueur sur la carte) suit chaque frame ; la reconstruction des listes de
     POI est limitée dans le temps, sinon le glissé saccade sur mobile. */
  const HEAVY_MS = 120;
  let heavyLast = 0, heavyTimer = null;

  function renderCursorLists(){
    heavyLast = performance.now();
    if (heavyTimer){ clearTimeout(heavyTimer); heavyTimer = null; }
    renderPoiList();
    renderCursorList();
  }

  function scheduleCursorLists(){
    const wait = HEAVY_MS - (performance.now() - heavyLast);
    if (wait <= 0){ renderCursorLists(); return; }
    if (!heavyTimer) heavyTimer = setTimeout(renderCursorLists, wait);
  }

  function setCursorKm(km, opts){
    cursorKm = Math.max(0, Math.min(totalKm, km));
    positionCursor(stripPlot);
    positionCursor(pvPlot);
    updateMapCursor(opts && opts.live);
    renderMapMeta();
    document.getElementById("strip-ax-c").textContent =
      cursorKm > 0.2 ? "repère · " + Math.round(cursorKm) : "";
    document.getElementById("strip-val").textContent =
      "reste " + fmtKm(Math.max(0, totalKm - cursorKm)) + " km · " +
      Math.round(Math.max(0, totalDplus - dplusAtKm(cursorKm))) + " m D+";
    if (opts && opts.live) scheduleCursorLists();
    else renderCursorLists();
  }

  function renderMapMeta(){
    document.getElementById("map-meta").textContent =
      (cursorKm > 0.2 ? "km " + fmtKm(cursorKm) + " · " : "") +
      "arrivée " + fmtClock(finishSec());
  }

  /**
   * Rend un profil balayable au doigt / à la souris.
   * `threshold` : distance (px) à franchir avant de prendre la main — utilisé
   * sur le bandeau, où un simple appui doit continuer d'ouvrir la vue Profil.
   * Retourne un objet exposant `moved` (le dernier geste était-il un glissé).
   */
  function wireScrub(el, threshold){
    const state = {moved:false};
    let active = false, startX = 0, startY = 0;

    function kmFromEvent(e){
      const g = el._plot;
      if (!g) return null;
      const r = el.getBoundingClientRect();
      if (!r.width) return null;
      const f = Math.max(0, Math.min(1, (e.clientX - r.left)/r.width));
      return g.kmFrom + f*(g.kmTo - g.kmFrom);
    }
    function scrub(e){
      const km = kmFromEvent(e);
      if (km != null) setCursorKm(km, {live:true});
    }

    el.addEventListener("pointerdown", e=>{
      if (e.button != null && e.button !== 0) return;
      active = true;
      state.moved = false;
      startX = e.clientX; startY = e.clientY;
      if (!threshold){
        el.setPointerCapture(e.pointerId);
        state.moved = true;
        scrub(e);
      }
    });
    el.addEventListener("pointermove", e=>{
      if (!active) return;
      if (!state.moved){
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < threshold) return;
        state.moved = true;
        el.setPointerCapture(e.pointerId);
      }
      scrub(e);
    });
    function end(){
      if (active && state.moved) setCursorKm(cursorKm); // rendu complet des listes
      active = false;
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", ()=>{ active = false; });
    return state;
  }

  wireScrub(pvPlot, 0);                          // grand profil : prise immédiate
  const stripScrub = wireScrub(stripPlot, 6);    // bandeau : appui = ouvrir, glissé = balayer

  /* ======================================================================
     14. Onglets
     ====================================================================== */
  function setView(name){
    activeView = name;
    document.querySelectorAll(".view").forEach(v=>{
      v.classList.toggle("is-active", v.id === "view-"+name);
    });
    document.querySelectorAll(".tabbar button").forEach(b=>{
      b.setAttribute("aria-selected", b.dataset.view === name);
    });
    if (name === "carte") requestAnimationFrame(fitRoute);
    if (name === "profil") renderBigPlot();
  }
  document.querySelectorAll(".tabbar button").forEach(b=>{
    b.addEventListener("click", ()=>setView(b.dataset.view));
  });
  document.getElementById("strip").addEventListener("click", ()=>{
    if (stripScrub.moved) return;   // le geste était un balayage, pas un appui
    setView("profil");
  });
  document.getElementById("fab-profil").addEventListener("click", ()=>setView("profil"));

  document.getElementById("pv-scope").querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      plotScope = b.dataset.scope;
      document.querySelectorAll("#pv-scope button").forEach(x=>{
        x.setAttribute("aria-pressed", x.dataset.scope === plotScope);
      });
      renderBigPlot();
    });
  });

  /* ======================================================================
     15. Feuille glissante
     ====================================================================== */
  (function wireSheet(){
    const sheet = document.getElementById("sheet");
    const grab = document.getElementById("sheet-grab");
    const view = document.getElementById("view-carte");
    const topbar = view.querySelector(".topbar");
    const peek = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--sheet-peek"), 10) || 246;
    let startY = 0, startH = 0, moved = 0, dragging = false;

    // Dépliée, la feuille occupe toute la hauteur sous la barre de titre
    // (sa marge négative est annulée en CSS dans cet état).
    function fullHeight(){
      return view.getBoundingClientRect().height -
             topbar.getBoundingClientRect().height;
    }

    function setFull(on){
      sheetFull = on;
      sheet.classList.toggle("is-full", on);
      sheet.style.height = on ? fullHeight() + "px" : "";
      grab.setAttribute("aria-expanded", String(on));
      if (activeView === "carte") requestAnimationFrame(fitRoute);
    }
    window.addEventListener("resize", ()=>{ if (sheetFull) sheet.style.height = fullHeight() + "px"; });

    grab.addEventListener("pointerdown", e=>{
      dragging = true; moved = 0;
      startY = e.clientY;
      startH = sheet.getBoundingClientRect().height;
      sheet.classList.add("is-dragging");
      grab.setPointerCapture(e.pointerId);
    });
    grab.addEventListener("pointermove", e=>{
      if (!dragging) return;
      const dy = startY - e.clientY;
      moved = Math.max(moved, Math.abs(dy));
      sheet.style.height = Math.max(peek*0.6, Math.min(fullHeight(), startH + dy)) + "px";
    });
    function end(){
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove("is-dragging");
      if (moved < 6){ setFull(!sheetFull); return; }
      const h = sheet.getBoundingClientRect().height;
      setFull(h > (peek + fullHeight())/2);
    }
    grab.addEventListener("pointerup", end);
    grab.addEventListener("pointercancel", end);
  })();

  /* ======================================================================
     16. Recalcul global
     ====================================================================== */
  function recompute(){
    document.getElementById("band-finish").textContent = fmtClock(finishSec());
    document.getElementById("band-pause").textContent =
      totalPauseSec() > 0 ? fmtHM(totalPauseSec()) : "—";
    renderMapMeta();
    renderStrip();
    renderPoiList();
    renderSuggestions();
    renderPauses();
    renderWaypoints();
    renderSplits();
    if (activeView === "profil") renderBigPlot();
    renderCursorList();
  }

  buildMap();
  renderFilters();
  renderBigPlot();
  recompute();
  updateMapCursor();
  setView("carte");
})();
