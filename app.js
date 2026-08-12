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
    food:  {label:"Kebab / Pizza", color:"var(--t-food)", icon:"🍕", on:true},
    cem:   {label:"Cimetière", color:"var(--t-cem)",   icon:"✚",  on:false}
  };
  const TYPE_GROUP = {
    drinking_water:"water", fountain:"water",
    bakery:"bread",
    convenience:"shop", supermarket:"shop",
    pizza:"food", kebab:"food", fast_food:"food",
    cemetery:"cem"
  };
  const TYPE_LABEL = {
    drinking_water:"Point d'eau", fountain:"Fontaine", bakery:"Boulangerie",
    convenience:"Épicerie", supermarket:"Supermarché",
    pizza:"Pizzeria", kebab:"Kebab", fast_food:"Restauration rapide",
    cemetery:"Cimetière", col:"Col"
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
  let cursorKm = 0;
  let activeView = "carte";
  // fenêtre visible du grand profil (zoom) ; initialisée sur tout le parcours
  let viewFrom = 0, viewTo = totalKm;
  const MIN_SPAN_KM = 1.5;   // zoom maxi : on ne descend pas sous 1,5 km affiché
  let sheetFull = false;
  const filters = new Set(Object.keys(GROUPS).filter(k=>GROUPS[k].on));

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
   * opts : {kmFrom, kmTo, topPct, pts, colLabels, poiMarks}
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
      poiMarks: pointsAhead(14).filter(p=>p.kind==="poi")
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

  /**
   * Cale la fenêtre de zoom : span borné à [MIN_SPAN_KM, totalKm], puis
   * translaté pour rester dans [0, totalKm]. Ne redessine pas.
   */
  function clampWindow(from, to){
    let span = Math.min(totalKm, Math.max(MIN_SPAN_KM, to - from));
    let f = from;
    if (f + span > totalKm) f = totalKm - span;
    if (f < 0) f = 0;
    return {from: f, to: f + span};
  }

  function setPlotWindow(from, to){
    const w = clampWindow(from, to);
    if (w.from === viewFrom && w.to === viewTo) return;
    viewFrom = w.from; viewTo = w.to;
    if (activeView === "profil") renderBigPlot();
  }

  /** Zoom d'un facteur `f` (>1 = on rentre) en gardant `anchorKm` sous le doigt. */
  function zoomBy(f, anchorKm){
    const span = viewTo - viewFrom;
    const a = anchorKm == null ? (viewFrom + viewTo)/2
                              : Math.max(viewFrom, Math.min(viewTo, anchorKm));
    const ratio = (a - viewFrom) / Math.max(1e-6, span);
    const newSpan = Math.min(totalKm, Math.max(MIN_SPAN_KM, span / f));
    setPlotWindow(a - ratio*newSpan, a - ratio*newSpan + newSpan);
  }

  function panBy(dKm){ setPlotWindow(viewFrom + dKm, viewTo + dKm); }

  /**
   * Recentre la fenêtre zoomée sur le repère (suivi GPS, clic carte) — mais
   * seulement si on le suivait déjà : si l'utilisateur a zoomé ailleurs pour
   * étudier un col, un point GPS ne doit pas lui reprendre la vue.
   */
  function ensureCursorVisible(prevKm){
    const span = viewTo - viewFrom;
    if (span >= totalKm) return;
    if (prevKm != null && (prevKm < viewFrom || prevKm > viewTo)) return;
    const pad = span * 0.12;
    if (cursorKm < viewFrom + pad)      setPlotWindow(cursorKm - pad, cursorKm - pad + span);
    else if (cursorKm > viewTo - pad)   setPlotWindow(cursorKm + pad - span, cursorKm + pad);
  }

  function renderBigPlot(){
    const from = viewFrom, to = viewTo;
    buildPlot(pvPlot, {
      kmFrom:from, kmTo:to, topPct:14, pts:600,
      colLabels:true,
      poiMarks: visiblePoints().filter(p=>p.kind==="poi" && p.km>=from && p.km<=to)
    });
    const zoomed = (to - from) < totalKm - 0.01;
    document.getElementById("pv-meta").textContent = zoomed
      ? "km " + fmtKm(from) + " – " + fmtKm(to)
      : fmtKm(totalKm) + " km · " + fmtInt(totalDplus) + " m D+";
    document.getElementById("pv-range").textContent = zoomed
      ? fmtKm(to - from) + " km · +" + fmtInt(Math.max(0, dplusAtKm(to) - dplusAtKm(from))) + " m"
      : "parcours entier";
    const zin = document.querySelector('#pv-zoom button[data-zoom="in"]');
    const zout = document.querySelector('#pv-zoom button[data-zoom="out"]');
    if (zin)  zin.disabled  = (to - from) <= MIN_SPAN_KM + 1e-6;
    if (zout) zout.disabled = !zoomed;
  }

  function renderCursorList(){
    const list = document.getElementById("pv-cursor-list");
    const title = document.getElementById("pv-cursor-title");
    const hint = document.getElementById("pv-cursor-hint");
    const idx = kmToIndex(cursorKm);
    const g = idx > 0 ? seg[idx-1].grad : 0;

    title.textContent = "Km " + fmtKm(cursorKm) + " · " + fmtInt(track[idx].ele) + " m";
    hint.textContent = "pente " + g.toFixed(1).replace(".",",") + " % · " +
                       fmtClock(movingSecAtKm(cursorKm));

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
      '<span class="dist"><b>'+(dist < 0 ? "0" : fmtKm(dist))+'</b><i>'+fmtClock(movingSecAtKm(p.km))+'</i></span>' +
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
    document.getElementById("poi-card-eta").textContent = fmtClock(movingSecAtKm(p.km));
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

  /* ======================================================================
     9. Tableaux (vue Plan)
     ====================================================================== */
  function renderWaypoints(){
    const body = document.getElementById("waypoints-body");
    const rows = [{name:"Départ", km:0, ele:track[0].ele}]
      .concat(ROUTE.cols.map(c=>({name:c.name, km:c.km, ele:c.ele, estimated:c.estimated})))
      .concat([{name:"Arrivée", km:totalKm, ele:track[N-1].ele}]);
    body.innerHTML = rows.map(p=>{
      const moving = movingSecAtKm(p.km);
      return '<tr data-km="'+p.km+'">' +
        '<td class="name">'+esc(p.name)+(p.estimated?'<span class="badge-est">estimé</span>':'')+'</td>' +
        '<td>'+fmtKm(p.km)+'</td><td>'+fmtInt(p.ele)+' m</td>' +
        '<td>+'+fmtInt(dplusAtKm(p.km))+' m</td>' +
        '<td>'+fmtHM(moving)+'</td>' +
        '<td>'+fmtClock(moving)+'</td></tr>';
    }).join("");
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
        '<td>'+fmtHM(moving)+'</td><td>'+fmtClock(moving)+'</td></tr>';
      prevDplus = dplus; prevDminus = dminus;
      if (kkm >= totalKm) break;
    }
    body.innerHTML = html;
  }

  /* ======================================================================
     10. Carte Leaflet
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
      color: "#e02020", weight:4, opacity:.95,
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
        color: "#2b3440",
        weight: 1,
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
      radius:6, color:"#2b3440", weight:1.5,
      fillColor:"#e02020", fillOpacity:1
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
     11. Géolocalisation
     ====================================================================== */
  /* Sur téléphone, le premier point GPS haute précision peut demander bien plus
     de temps qu'en Wi-Fi sur ordinateur, et le navigateur émet des erreurs
     passagères (TIMEOUT, POSITION_UNAVAILABLE) avant d'accrocher les satellites.
     On ne coupe donc le suivi que sur un refus de permission ; le reste est
     signalé sans interrompre. Une première demande basse précision (réseau)
     donne un point approximatif en quelques secondes en attendant le vrai fix. */
  let geoWatchId = null, geoMarker = null, geoCircle = null, geoHasFix = false;
  let geoMsgTimer = null;

  function geoMessage(text, sticky){
    const el = document.getElementById("geo-msg");
    if (!el) return;
    clearTimeout(geoMsgTimer);
    if (!text){ el.classList.remove("is-on"); el.textContent = ""; return; }
    el.textContent = text;
    el.classList.add("is-on");
    if (!sticky) geoMsgTimer = setTimeout(()=>geoMessage(""), 4000);
  }

  function setGeoBtnState(state){ // "off" | "wait" | "on"
    const btn = document.getElementById("geoloc-toggle");
    btn.setAttribute("aria-pressed", state === "off" ? "false" : "true");
    btn.classList.toggle("is-waiting", state === "wait");
    btn.title = state === "off" ? "Afficher ma position"
      : state === "wait" ? "Recherche de la position…"
      : "Suivi en cours — appuyer pour arrêter";
  }

  function onGeoPosition(pos){
    const {latitude, longitude, accuracy} = pos.coords;
    const latlng = [latitude, longitude];
    geoHasFix = true;
    setGeoBtnState("on");
    geoMessage("");
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

  function onGeoError(err){
    // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
    if (err.code === 1){
      stopGeolocation();
      geoMessage("Position refusée. Autorisez la localisation pour ce site " +
                 "dans les réglages du navigateur.", true);
      return;
    }
    if (geoHasFix) return; // simple décrochage passager, le suivi continue
    geoMessage(err.code === 3
      ? "Recherche du signal GPS… (sortez à découvert, ça peut prendre 1 min)"
      : "Signal GPS indisponible pour l'instant — recherche en cours…", true);
  }

  function stopGeolocation(){
    if (geoWatchId != null){ navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    geoHasFix = false;
    setGeoBtnState("off");
    geoMessage("");
    if (geoMarker) { map.removeLayer(geoMarker); geoMarker = null; }
    if (geoCircle) { map.removeLayer(geoCircle); geoCircle = null; }
  }

  document.getElementById("geoloc-toggle").addEventListener("click", ()=>{
    if (geoWatchId != null){ stopGeolocation(); return; }
    if (!navigator.geolocation){
      geoMessage("La géolocalisation n'est pas disponible sur cet appareil.", true);
      return;
    }
    if (!window.isSecureContext){
      geoMessage("La géolocalisation exige une connexion sécurisée (https).", true);
      return;
    }
    geoHasFix = false;
    setGeoBtnState("wait");
    geoMessage("Recherche de la position…", true);

    // point approximatif rapide (réseau) pour ne pas rester sans repère
    navigator.geolocation.getCurrentPosition(
      pos=>{ if (geoWatchId != null && !geoHasFix) onGeoPosition(pos); },
      ()=>{},
      {enableHighAccuracy:false, maximumAge:60000, timeout:8000}
    );

    geoWatchId = navigator.geolocation.watchPosition(
      onGeoPosition, onGeoError,
      {enableHighAccuracy:true, maximumAge:5000, timeout:60000}
    );
  });

  /* ======================================================================
     12. Curseur partagé
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
    const prevKm = cursorKm;
    cursorKm = Math.max(0, Math.min(totalKm, km));
    // hors balayage (GPS, clic carte), le profil zoomé se recale sur le repère
    if (!(opts && opts.live)) ensureCursorVisible(prevKm);
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
      "arrivée " + fmtClock(totalMovingSec);
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

    function fracFromEvent(e){
      const r = el.getBoundingClientRect();
      if (!r.width) return null;
      return Math.max(0, Math.min(1, (e.clientX - r.left)/r.width));
    }
    function kmFromEvent(e){
      const g = el._plot;
      const f = g ? fracFromEvent(e) : null;
      return f == null ? null : g.kmFrom + f*(g.kmTo - g.kmFrom);
    }
    function scrub(e){
      const km = kmFromEvent(e);
      if (km != null) setCursorKm(km, {live:true});
      if (el === pvPlot) edgePan(fracFromEvent(e));
    }

    /* Balayage sur un profil zoomé : maintenir le doigt contre un bord fait
       défiler la fenêtre, sinon on ne pourrait pas dépasser le cadre. */
    let edgeDir = 0, edgeRaf = null, edgeLast = 0;
    const EDGE_SPANS_PER_SEC = 0.4;   // une largeur d'écran toutes les 2,5 s
    function edgePan(f){
      const d = f == null ? 0 : (f < 0.05 ? -1 : (f > 0.95 ? 1 : 0));
      if (d === edgeDir) return;
      edgeDir = d;
      if (d === 0) return stopEdgePan();
      if (edgeRaf == null){
        edgeLast = performance.now();
        edgeRaf = requestAnimationFrame(edgeStep);
      }
    }
    function edgeStep(now){
      edgeRaf = null;
      if (!active || !edgeDir) return;
      const dt = Math.min(0.1, (now - edgeLast)/1000);   // borne les gros sauts
      edgeLast = now;
      const span = viewTo - viewFrom;
      if (span < totalKm){
        panBy(edgeDir * span * EDGE_SPANS_PER_SEC * dt);
        setCursorKm(edgeDir < 0 ? viewFrom : viewTo, {live:true});
      }
      edgeRaf = requestAnimationFrame(edgeStep);
    }
    function stopEdgePan(){
      edgeDir = 0;
      if (edgeRaf != null){ cancelAnimationFrame(edgeRaf); edgeRaf = null; }
    }

    el.addEventListener("pointerdown", e=>{
      if (e.button != null && e.button !== 0) return;
      if (pinchActive()) return;
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
      if (pinchActive()){ stopEdgePan(); active = false; return; }
      if (!state.moved){
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < threshold) return;
        state.moved = true;
        el.setPointerCapture(e.pointerId);
      }
      scrub(e);
    });
    function end(){
      stopEdgePan();
      if (active && state.moved) setCursorKm(cursorKm); // rendu complet des listes
      active = false;
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", ()=>{ stopEdgePan(); active = false; });
    return state;
  }

  /* ---- pincer pour zoomer / deux doigts pour faire défiler (grand profil) ---- */
  const pinchPts = new Map();
  let pinchRef = null;   // {dist, centerKm, span}
  function pinchActive(){ return pinchPts.size >= 2; }

  function pinchGeom(){
    const [a, b] = [...pinchPts.values()];
    const r = pvPlot.getBoundingClientRect();
    const dist = Math.max(1, Math.abs(a.x - b.x));
    const f = Math.max(0, Math.min(1, ((a.x + b.x)/2 - r.left)/Math.max(1, r.width)));
    return {dist, f};
  }

  pvPlot.addEventListener("pointerdown", e=>{
    pinchPts.set(e.pointerId, {x:e.clientX});
    if (pinchActive()){
      const g = pinchGeom();
      const span = viewTo - viewFrom;
      pinchRef = {dist:g.dist, span, centerKm: viewFrom + g.f*span, f:g.f};
    }
  });
  pvPlot.addEventListener("pointermove", e=>{
    if (!pinchPts.has(e.pointerId)) return;
    pinchPts.set(e.pointerId, {x:e.clientX});
    if (!pinchActive() || !pinchRef) return;
    const g = pinchGeom();
    const span = Math.min(totalKm, Math.max(MIN_SPAN_KM, pinchRef.span * pinchRef.dist / g.dist));
    // le centre suit le milieu des doigts : le pincement fait aussi office de pan
    setPlotWindow(pinchRef.centerKm - g.f*span, pinchRef.centerKm + (1-g.f)*span);
  });
  function pinchDrop(e){
    pinchPts.delete(e.pointerId);
    if (!pinchActive()) pinchRef = null;
  }
  pvPlot.addEventListener("pointerup", pinchDrop);
  pvPlot.addEventListener("pointercancel", pinchDrop);
  pvPlot.addEventListener("pointerleave", pinchDrop);

  /* ---- molette : zoom au pointeur, shift/molette horizontale : défilement ---- */
  pvPlot.addEventListener("wheel", e=>{
    e.preventDefault();
    const r = pvPlot.getBoundingClientRect();
    if (!r.width) return;
    const f = Math.max(0, Math.min(1, (e.clientX - r.left)/r.width));
    const span = viewTo - viewFrom;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)){
      panBy((e.deltaX || e.deltaY) / r.width * span);
    } else {
      zoomBy(Math.exp(-e.deltaY * 0.002), viewFrom + f*span);
    }
  }, {passive:false});

  wireScrub(pvPlot, 0);                          // grand profil : prise immédiate
  const stripScrub = wireScrub(stripPlot, 6);    // bandeau : appui = ouvrir, glissé = balayer

  /* ======================================================================
     13. Onglets
     ====================================================================== */
  function setView(name){
    activeView = name;
    document.querySelectorAll(".view").forEach(v=>{
      v.classList.toggle("is-active", v.id === "view-"+name);
    });
    document.querySelectorAll(".tabbar .tabs button").forEach(b=>{
      b.setAttribute("aria-selected", b.dataset.view === name);
    });
    if (name === "carte") requestAnimationFrame(fitRoute);
    if (name === "profil") renderBigPlot();
  }
  document.querySelectorAll(".tabbar .tabs button").forEach(b=>{
    b.addEventListener("click", ()=>setView(b.dataset.view));
  });
  document.getElementById("strip").addEventListener("click", ()=>{
    if (stripScrub.moved) return;   // le geste était un balayage, pas un appui
    setView("profil");
  });
  document.getElementById("fab-profil").addEventListener("click", ()=>setView("profil"));

  document.getElementById("pv-zoom").querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const span = viewTo - viewFrom;
      switch (b.dataset.zoom){
        case "in":  zoomBy(1.6, cursorInWindow() ? cursorKm : null); break;
        case "out": zoomBy(1/1.6, cursorInWindow() ? cursorKm : null); break;
        case "fit": setPlotWindow(0, totalKm); break;
        case "here": {
          const s = Math.min(totalKm, span >= totalKm ? 20 : span);
          setPlotWindow(cursorKm - s/2, cursorKm + s/2);
          break;
        }
      }
    });
  });
  function cursorInWindow(){ return cursorKm >= viewFrom && cursorKm <= viewTo; }

  /* ======================================================================
     14. Feuille glissante
     ====================================================================== */
  (function wireSheet(){
    const sheet = document.getElementById("sheet");
    const grab = document.getElementById("sheet-grab");
    const view = document.getElementById("view-carte");
    const topbar = view.querySelector(".topbar");
    const cssPx = (name, fallback) => parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue(name), 10) || fallback;
    const peek = cssPx("--sheet-peek", 246);
    const collapsed = cssPx("--sheet-collapsed", 26);
    let startY = 0, startH = 0, moved = 0, dragging = false;
    // Trois positions : escamotée (carte entière), entrouverte, dépliée.
    let sheetState = "peek";

    // Dépliée, la feuille occupe toute la hauteur sous la barre de titre
    // (sa marge négative est annulée en CSS dans cet état).
    function fullHeight(){
      return view.getBoundingClientRect().height -
             topbar.getBoundingClientRect().height;
    }
    function heightFor(state){
      return state === "full" ? fullHeight()
           : state === "collapsed" ? collapsed
           : peek;
    }

    function setState(state){
      sheetState = state;
      sheetFull = state === "full";
      sheet.classList.toggle("is-full", state === "full");
      sheet.classList.toggle("is-collapsed", state === "collapsed");
      // La hauteur des états fixes vient du CSS ; seule « full » se mesure.
      sheet.style.height = state === "full" ? fullHeight() + "px" : "";
      grab.setAttribute("aria-expanded", String(state !== "collapsed"));
      grab.setAttribute("aria-label",
        state === "collapsed" ? "Déplier la liste des ravitaillements"
        : state === "peek"    ? "Agrandir la liste des ravitaillements"
        :                       "Escamoter la feuille pour voir la carte");
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
      // Pendant le glissé, on laisse descendre jusqu'à la position escamotée.
      sheet.style.height = Math.max(collapsed, Math.min(fullHeight(), startH + dy)) + "px";
      // Le clip de la feuille escamotée doit suivre le doigt, pas seulement
      // l'état final, sinon le bandeau profil dépasse en cours de glissé.
      sheet.classList.toggle("is-full", startH + dy >= fullHeight() - 1);
    });
    function end(){
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove("is-dragging");
      if (moved < 6){
        // Appui simple : on cycle escamotée → entrouverte → dépliée → …
        setState(sheetState === "collapsed" ? "peek"
               : sheetState === "peek"      ? "full"
               :                              "collapsed");
        return;
      }
      // Glissé : on se cale sur la position la plus proche des trois.
      const h = sheet.getBoundingClientRect().height;
      const nearest = ["collapsed", "peek", "full"]
        .reduce((best, s) =>
          Math.abs(heightFor(s) - h) < Math.abs(heightFor(best) - h) ? s : best);
      setState(nearest);
    }
    grab.addEventListener("pointerup", end);
    grab.addEventListener("pointercancel", end);
    setState("peek");
  })();

  /* ======================================================================
     15. Recalcul global
     ====================================================================== */
  function recompute(){
    renderMapMeta();
    renderStrip();
    renderPoiList();
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
