import { useState, useCallback, useRef, useEffect, useMemo, useImperativeHandle, forwardRef, Component } from "react";
import * as XLSX from "xlsx";
import { P } from "./App.jsx";

// ── Error Boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:32,fontFamily:"monospace",color:"#F44336",background:"#fff"}}>
          <strong>Erro no dashboard:</strong><br/>
          {this.state.error.message}<br/>
          <button onClick={()=>this.setState({error:null})} style={{marginTop:12,padding:"6px 14px",cursor:"pointer"}}>
            Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Paleta & cores ────────────────────────────────────────────────────────────
const PALETTE = [
  "#1656d6","#F5A623","#4CAF50","#E91E63","#9C27B0","#00BCD4","#FF5722","#795548",
  "#1DE9B6","#FF6D00","#8BC34A","#D500F9","#00BFA5","#FFD740","#304FFE","#607D8B",
  "#3F51B5","#00C853","#AA00FF","#0091EA","#64DD17","#FF6E40","#F9A825","#FF4081",
  "#651FFF","#40C4FF","#69F0AE","#CDDC39","#FF9800","#00ACC1","#E040FB","#F50057",
];
function varColor(idx, vi) { return PALETTE[(idx + vi * 8) % PALETTE.length]; }
const DASH_PATTERNS = [[], [6,3], [2,2], [9,3,2,3]];

// ── Variáveis ─────────────────────────────────────────────────────────────────
const VAR_GROUPS = [
  { label:"Potência", vars:[
    { key:"pac",  label:"pac (kW)",   unit:"kW"   },
    { key:"pdc",  label:"pdc (kW)",   unit:"kW"   },
    { key:"qac",  label:"qac (kVAr)", unit:"kVAr" },
  ]},
  { label:"Energia", vars:[
    { key:"dailyEnergyInjected", label:"Injetada (kWh)",  unit:"kWh" },
    { key:"dailyEnergyAbsorbed", label:"Absorvida (kWh)", unit:"kWh" },
  ]},
  { label:"Tensões DC", vars:[
    { key:"vdc",   label:"vdc (V)",   unit:"V" },
    { key:"vbus",  label:"vbus (V)",  unit:"V" },
    { key:"pvbus", label:"pvbus (V)", unit:"V" },
    { key:"nvbus", label:"nvbus (V)", unit:"V" },
  ]},
  { label:"Corrente DC", vars:[{ key:"idc", label:"idc (A)", unit:"A" }]},
  { label:"Tensões AC", vars:[
    { key:"vac1",  label:"vac1 (V)",  unit:"V" },
    { key:"vac2",  label:"vac2 (V)",  unit:"V" },
    { key:"vac3",  label:"vac3 (V)",  unit:"V" },
    { key:"vaux1", label:"vaux1 (V)", unit:"V" },
    { key:"vaux2", label:"vaux2 (V)", unit:"V" },
    { key:"vaux3", label:"vaux3 (V)", unit:"V" },
  ]},
  { label:"Correntes AC", vars:[
    { key:"iac1", label:"iac1 (A)", unit:"A" },
    { key:"iac2", label:"iac2 (A)", unit:"A" },
    { key:"iac3", label:"iac3 (A)", unit:"A" },
  ]},
  { label:"Frequência", vars:[{ key:"fac", label:"fac (Hz)", unit:"Hz" }]},
  { label:"Temperatura", vars:[
    { key:"tempColdCoolant", label:"Coolant (ºC)",    unit:"ºC" },
    { key:"tempStack",       label:"Stack (ºC)",       unit:"ºC" },
    { key:"tempAcCabinet",   label:"Cabinet AC (ºC)", unit:"ºC" },
    { key:"tempDcCabinet",   label:"Cabinet DC (ºC)", unit:"ºC" },
    { key:"tempInductor",    label:"Indutor (ºC)",     unit:"ºC" },
    { key:"tempOutside",     label:"Externa (ºC)",     unit:"ºC" },
  ]},
  { label:"Taxa de Saída", vars:[
    { key:"outHwRate",  label:"outHwRate (%)",  unit:"%" },
    { key:"outPacRate", label:"outPacRate (%)", unit:"%" },
    { key:"outQacRate", label:"outQacRate (%)", unit:"%" },
  ]},
  { label:"Isolamento", vars:[
    { key:"positiveRiso", label:"Riso+ (kΩ)", unit:"kΩ" },
    { key:"negativeRiso", label:"Riso- (kΩ)", unit:"kΩ" },
    { key:"gndBoardIgnd", label:"Ignd (A)",   unit:"A"  },
    { key:"totalCiso",    label:"Ciso (μF)",  unit:"μF" },
  ]},
];
const ALL_VARS = VAR_GROUPS.flatMap(g => g.vars);
const VAR_MAP  = Object.fromEntries(ALL_VARS.map(v => [v.key, v]));
const NONE     = "__none__";

// ── Disponibilidade: constantes ───────────────────────────────────────────────
const AVAIL_END       = "17:30";   // fim do janela de geração
const AVAIL_DEF_START = "05:30";   // início padrão (fallback)
const GEN_THRESHOLD   = 1.0;       // kW — mínimo p/ considerar "gerando"
const MIN_STOP_MINS   = 3;         // paradas ≤ 3 min são descartadas (nuvem/sol nascendo/pondo)
const END_TOLERANCE   = 5;         // ignora parada nos últimos N min do dia (sol se pondo cedo)

// ── Helpers de tempo ──────────────────────────────────────────────────────────
function timeToMins(t) {
  if (!t || typeof t !== "string") return 0;
  const [h="0", m="0"] = t.split(":");
  return parseInt(h,10)*60 + parseInt(m,10);
}
function minsToTime(m) {
  return `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
}
function fmtMins(mins) {
  if (mins == null || isNaN(mins)) return "—";
  if (mins <= 0) return "0min";
  const h = Math.floor(mins/60);
  const m = Math.round(mins%60);
  if (h===0) return `${m}min`;
  if (m===0) return `${h}h`;
  return `${h}h${String(m).padStart(2,"0")}min`;
}

// ── Disponibilidade: motor de cálculo ────────────────────────────────────────

// Preenche timeline minuto a minuto, gaps herdam estado anterior
function buildTimeline(data, startMins, endMins) {
  const map = {};
  (data||[]).forEach(r => { if (r.time) map[r.time] = r.pac; });
  let lastPac = null;
  const tl = [];
  for (let m = startMins; m <= endMins; m++) {
    const t = minsToTime(m);
    if (map[t] !== undefined) {
      lastPac = map[t];
      tl.push({ time:t, pac:map[t], gap:false });
    } else {
      // Gap: se estava parado (≤0 ou null) → continua parado; senão → herda geração
      const inferred = (lastPac === null || lastPac <= 0) ? 0 : lastPac;
      tl.push({ time:t, pac:inferred, gap:true });
    }
  }
  return tl;
}

// Detecta intervalos de parada numa timeline
function findStopIntervals(timeline) {
  const intervals = [];
  let stopStart = null;
  for (let i = 0; i < timeline.length; i++) {
    const stopped = timeline[i].pac === null || timeline[i].pac <= 0;
    if (stopped && stopStart === null) {
      stopStart = i;
    } else if (!stopped && stopStart !== null) {
      const from = timeline[stopStart].time;
      const to   = timeline[i-1].time;
      intervals.push({ start:from, end:to, mins: timeToMins(to)-timeToMins(from)+1 });
      stopStart = null;
    }
  }
  if (stopStart !== null && timeline.length > 0) {
    const from = timeline[stopStart].time;
    const to   = timeline[timeline.length-1].time;
    intervals.push({ start:from, end:to, mins: timeToMins(to)-timeToMins(from)+1 });
  }
  return intervals;
}

// Detecta o início de cálculo de disponibilidade POR INVERSOR:
// — Se o inversor começou a gerar até as 06:00 → conta a partir do seu início real (variação
//   normal de irradiância/sombreamento entre inversores — já visto inversor partindo às 05:45
//   e outro só às 06:00 no mesmo dia, sem nenhuma falha)
// — Se começou depois das 06:00 (ou nunca gerou) → conta desde 05:30 (indisponível), pois aí
//   sim o intervalo 05:30–06:00 indica uma parada real, não irradiância
function detectInverterStart(data) {
  const defMins = timeToMins(AVAIL_DEF_START); // 05:30
  const cutoff  = timeToMins("06:00");          // inclusivo: início até 06:00 é natural
  if (!data || !data.length) return defMins;
  const gen = data.find(r =>
    r.time >= AVAIL_DEF_START && r.time <= AVAIL_END &&
    r.pac !== null && r.pac > GEN_THRESHOLD
  );
  if (!gen) return defMins;
  const m = timeToMins(gen.time);
  return m <= cutoff ? m : defMins;
}

// Mantido para compatibilidade com chamadas existentes (usa detectInverterStart internamente)
function detectSmartStart(invertersDataArr) {
  if (!invertersDataArr.length) return timeToMins(AVAIL_DEF_START);
  // Retorna o início mais cedo entre os inversores (cada um já calculado individualmente)
  const starts = invertersDataArr.map(detectInverterStart);
  return Math.min(...starts);
}

// Calcula disponibilidade de um inversor num dia
function calcDayAvail(data, smartStartMins) {
  const endMins      = timeToMins(AVAIL_END);
  const tl           = buildTimeline(data, smartStartMins, endMins);
  const rawIntervals = findStopIntervals(tl);

  // Tolerância de fim de dia: descarta parada que começa nos últimos END_TOLERANCE minutos
  // (sol se pondo mais cedo — não é falha do inversor)
  const endToleranceStart = endMins - END_TOLERANCE;
  const intervalsNoEndNoise = rawIntervals.filter(iv => {
    const ivStartMins = timeToMins(iv.start);
    return ivStartMins < endToleranceStart; // mantém só paradas que começaram antes da janela de pôr-do-sol
  });

  // Tolerância de paradas curtas: descarta eventos ≤ MIN_STOP_MINS min
  const intervals = intervalsNoEndNoise.filter(iv => iv.mins > MIN_STOP_MINS);

  const stoppedMins = intervals.reduce((s,iv) => s + iv.mins, 0);
  const stoppedH    = stoppedMins / 60;
  const avail       = isFinite(stoppedH) ? Math.max(0, Math.min(100, (12 - stoppedH) / 12 * 100)) : 0;
  return { availability:avail, stoppedMins, stoppedHours:stoppedH, intervals, rawIntervals };
}

function availColor(pct) {
  if (pct == null) return "var(--color-text-tertiary)";
  if (pct >= 90) return "#4CAF50";
  if (pct >= 70) return "#FF9800";
  return "#F44336";
}

// ── Helpers de parsing ────────────────────────────────────────────────────────
function datetimeToHHMM(val) {
  if (!val) return "00:00";
  if (val instanceof Date) {
    return `${String(val.getUTCHours()).padStart(2,"0")}:${String(val.getUTCMinutes()).padStart(2,"0")}`;
  }
  const s = String(val).trim();
  const part = s.includes(" ") ? s.split(" ")[1] : s;
  const [h="0", m="0"] = part.split(":");
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function valToDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val)) return null;
    return `${val.getUTCFullYear()}-${String(val.getUTCMonth()+1).padStart(2,"0")}-${String(val.getUTCDate()).padStart(2,"0")}`;
  }
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return null;
}
function buildColMap(headers) {
  const map = {};
  ALL_VARS.forEach(({ key }) => {
    const found = headers.find(h => {
      if (!h) return false;
      const clean = String(h).toLowerCase()
        .replace(/\s*[\[(（].*?[\]）)]/g,"").replace(/[ºãçáéíóú°â]/gi,"").trim();
      return clean === key.toLowerCase();
    });
    if (found != null) map[key] = found;
  });
  return map;
}
function invKeyFromSheet(sheetName, filename) {
  const m = sheetName.match(/node[_\-]([A-Za-z0-9]+?)(?:[_\-]\d+)?$/i);
  if (m) return m[1];
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_\-]\d+$/, "");
  const m2   = base.match(/node[_\-]([A-Za-z0-9]+)/i);
  return m2 ? m2[1] : base.slice(-20);
}
function displayNameFromFile(filename) {
  return filename.replace(/\.[^.]+$/, ""); // remove extension, keep full name
}

async function parseXLSXMultiSheet(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type:"array", cellDates:true });
        const results = [];
        wb.SheetNames.forEach(sheetName => {
          const ws   = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(ws, { defval:null });
          if (!rows.length) return;
          const headers = Object.keys(rows[0]);
          const timeCol = headers.find(h => h.toLowerCase().trim()==="time") || headers[0];
          const colMap  = buildColMap(headers);
          let sheetDate = null;
          for (const row of rows) {
            const d = valToDate(row[timeCol]);
            if (d) { sheetDate = d; break; }
          }
          if (!sheetDate) return;
          const invKey     = invKeyFromSheet(sheetName, file.name);
          const displayName = displayNameFromFile(file.name);
          const data = rows.filter(r => r[timeCol]).map(row => {
            const entry = { time: datetimeToHHMM(row[timeCol]) };
            ALL_VARS.forEach(({ key }) => {
              const col = colMap[key];
              const raw = col != null ? row[col] : null;
              const v   = raw !== null && raw !== undefined
                ? (typeof raw==="number" ? raw : parseFloat(String(raw).replace(",",".")))
                : NaN;
              entry[key] = isFinite(v) ? v : null;
            });
            return entry;
          });
          results.push({ invKey, displayName, date:sheetDate, data });
        });
        resolve(results);
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function registerSmartTooltip() {
  if (window._smartTooltipRegistered) return;
  window._smartTooltipRegistered = true;
  window.Chart.Tooltip.positioners.smart = function(elements, pos) {
    if (!elements.length) return false;
    const ca = this.chart.chartArea;
    const cx = pos.x - ca.left,  cy = pos.y - ca.top;
    const cw = ca.right - ca.left, ch = ca.bottom - ca.top;
    const goRight  = cx < cw/2;
    const goBottom = cy < ch/2;
    return {
      x: goRight ? ca.right - 20 : ca.left + 20,
      y: goBottom ? ca.bottom - 20 : ca.top + 20,
      xAlign: goRight ? "right" : "left",
      yAlign: goBottom ? "bottom" : "top",
    };
  };
}

// ── Chart libs ────────────────────────────────────────────────────────────────
function loadChartLibs() {
  return new Promise(resolve => {
    if (window._chartReady) { resolve(); return; }
    const load = src => new Promise(res => {
      const s = document.createElement("script"); s.src=src; s.onload=res; document.head.appendChild(s);
    });
    load("https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js")
      .then(()=>load("https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"))
      .then(()=>load("https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-zoom/2.0.1/chartjs-plugin-zoom.min.js"))
      .then(()=>{ window.Chart.register(window.ChartZoom); registerSmartTooltip(); window._chartReady=true; resolve(); });
  });
}

// ── Hook divisor arrastável ───────────────────────────────────────────────────
function useDivider(initial, min, max, dir="horizontal") {
  const [size, setSize] = useState(initial);
  const drag    = useRef(false);
  const start   = useRef({ pos:0, size:0 });
  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);
  const onMouseDown = useCallback(e => {
    e.preventDefault();
    drag.current  = true;
    start.current = { pos: dir==="horizontal"?e.clientX:e.clientY, size: sizeRef.current };
    const onMove = ev => {
      if (!drag.current) return;
      const raw = (dir==="horizontal"?ev.clientX:ev.clientY) - start.current.pos;
      const delta = dir==="vertical" ? -raw : raw;
      setSize(Math.max(min, Math.min(max, start.current.size + delta)));
    };
    const onUp = () => { drag.current=false; window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };
    window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp);
  }, [min, max, dir]);   // ← size removed from deps; read via sizeRef instead
  return [size, onMouseDown];
}

// ── Gráfico de Variáveis ──────────────────────────────────────────────────────
function InverterChart({ inverters, varKeys, onPointClick }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const [ready, setReady] = useState(!!window._chartReady);
  const cbRef    = useRef(onPointClick);
  useEffect(()=>{ cbRef.current=onPointClick; },[onPointClick]);
  useEffect(()=>{ if(window._chartReady){registerSmartTooltip();setReady(true);return;} loadChartLibs().then(()=>setReady(true)); },[]);

  useEffect(()=>{
    if(!ready||!canvasRef.current) return;
    if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}
    const visible=inverters.filter(i=>i.visible);
    const av=varKeys.filter(k=>k!==NONE);
    if(!visible.length||!av.length) return;

    // Régua de horário construída a partir de TODOS os inversores carregados, não só os
    // visíveis: se o único visível ficou fora do ar, seu próprio arquivo não tem linhas
    // pro período parado, e a régua encolheria pro intervalo que ele reportou (parecendo
    // geração contínua). Usar todos garante o mesmo eixo independente do que está marcado.
    const timeSet=new Set();
    inverters.forEach(inv=>inv.data.forEach(r=>timeSet.add(r.time)));
    const labels=Array.from(timeSet).sort();

    const units=[...new Set(av.map(k=>VAR_MAP[k]?.unit??""))];
    const axisFor=u=>units.indexOf(u)===0?"y1":"y2";
    const dual=units.length>1;

    const datasets=[];
    visible.forEach(inv=>{
      av.forEach((varKey,vi)=>{
        const info=VAR_MAP[varKey]||{unit:"",label:varKey};
        const color=varColor(inv.paletteIdx,vi);
        const byt={};
        inv.data.forEach(r=>{byt[r.time]=r[varKey];});
        datasets.push({
          label:`${inv.displayName||inv.name} — ${info.label}`,
          invId:inv.id,varKey,vi,
          data:labels.map(t=>{const v=byt[t];return(v!==undefined&&v!==null)?v:null;}),
          borderColor:color,backgroundColor:"transparent",
          borderWidth:1.8,borderDash:DASH_PATTERNS[vi],
          pointRadius:0,pointHoverRadius:5,tension:0.4,spanGaps:false,
          yAxisID:axisFor(info.unit),
        });
      });
    });

    const scales={
      x:{afterBuildTicks:axis=>{const tks=axis.ticks;if(!tks.length)return;const toMin=l=>(l&&l.length>=5)?parseInt(l.slice(0,2),10)*60+parseInt(l.slice(3,5),10):null;const f=toMin(axis.getLabelForValue(tks[0].value)),lt=toMin(axis.getLabelForValue(tks[tks.length-1].value));const span=(f!=null&&lt!=null)?Math.max(1,Math.abs(lt-f)):60;const steps=[1,2,5,10,15,20,30,60,120,180];let step=180;for(const s of steps){if(span/s<=14){step=s;break;}}axis.ticks=tks.filter(tk=>{const m=toMin(axis.getLabelForValue(tk.value));return m!=null&&m%step===0;});},
        ticks:{color:"#8595A6",font:{size:11},maxRotation:0,autoSkip:false,
          callback:function(value){return this.getLabelForValue(value)||"";}},
        grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"}},
      y1:{position:"left",ticks:{color:"#8595A6",font:{size:11},maxTicksLimit:8},
        grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
        title:{display:true,text:units[0]??"",color:"#A7B6C6",font:{size:11}}},
    };
    if(dual) scales.y2={position:"right",ticks:{color:"#666",font:{size:11},maxTicksLimit:8},
      grid:{drawOnChartArea:false},border:{color:"rgba(148,163,184,0.22)"},
      title:{display:true,text:units[1]??"",color:"#666",font:{size:11}}};

    chartRef.current=new window.Chart(canvasRef.current,{
      type:"line",data:{labels,datasets},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        interaction:{mode:"index",intersect:false},
        onClick:(_,els,ch)=>{if(!els.length)return;cbRef.current?.(ch.data.labels[els[0].index]);},
        plugins:{legend:{display:false},
          tooltip:{position:"smart",backgroundColor:"rgba(38,50,68,0.97)",titleColor:"#A7B6C6",bodyColor:"#EAF2FB",
            borderColor:"rgba(46,155,255,0.40)",borderWidth:1,padding:10,
            callbacks:{title:items=>items[0]?.label??"",
              label:ctx=>{const v=ctx.parsed.y;const info=VAR_MAP[ctx.dataset.varKey];
                return `  ${ctx.dataset.label}: ${v!==null?v.toFixed(3)+" "+(info?.unit??""):"—"}`;},
              labelTextColor:ctx=>ctx.dataset.borderColor}},
          zoom:{pan:{enabled:true,mode:"xy",threshold:10},
            zoom:{wheel:{enabled:true,mode:"xy"},pinch:{enabled:false},
              drag:{enabled:false},
              mode:"xy"}}},
        scales},
    });
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}};
  },[ready,inverters,varKeys]);

  return(
    <div style={{position:"relative",width:"100%",height:"100%"}}>
      {!ready&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--color-text-tertiary)",fontSize:13}}>Carregando…</div>}
      <canvas ref={canvasRef} role="img" style={{cursor:"crosshair"}} onDoubleClick={()=>chartRef.current?.resetZoom()}/>
    </div>
  );
}

// ── Gráfico de Desbalanceamento ───────────────────────────────────────────────
function ImbalanceChart({ inverters, onPointClick }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const [ready, setReady] = useState(!!window._chartReady);
  const cbRef = useRef(onPointClick);
  useEffect(()=>{cbRef.current=onPointClick;},[onPointClick]);
  useEffect(()=>{if(window._chartReady){registerSmartTooltip();setReady(true);return;}loadChartLibs().then(()=>setReady(true));},[]);

  useEffect(()=>{
    if(!ready||!canvasRef.current) return;
    if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}
    const visible=inverters.filter(i=>i.visible);
    if(!visible.length) return;
    // Mesmo raciocínio do InverterChart: régua a partir de todos os carregados, não só os
    // visíveis, senão um único inversor fora do ar visível sozinho encolhe o eixo de horário.
    const timeSet=new Set();
    inverters.forEach(inv=>inv.data.forEach(r=>timeSet.add(r.time)));
    const labels=Array.from(timeSet).sort();
    const datasets=visible.map(inv=>{
      const byt={};
      inv.data.forEach(r=>{
        if(r.pvbus!==null&&r.nvbus!==null){
          const s=r.pvbus+r.nvbus;byt[r.time]=s!==0?Math.abs((r.pvbus-r.nvbus)/s)*100:0;
        }
      });
      return{label:inv.displayName||inv.name,invId:inv.id,
        data:labels.map(t=>byt[t]!==undefined?byt[t]:null),
        borderColor:inv.color,backgroundColor:"transparent",
        borderWidth:1.8,pointRadius:0,pointHoverRadius:5,tension:0.4,spanGaps:false};
    });
    chartRef.current=new window.Chart(canvasRef.current,{
      type:"line",data:{labels,datasets},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        interaction:{mode:"index",intersect:false},
        onClick:(_,els,ch)=>{if(!els.length)return;cbRef.current?.(ch.data.labels[els[0].index]);},
        plugins:{legend:{display:false},
          tooltip:{position:"smart",backgroundColor:"rgba(38,50,68,0.97)",titleColor:"#A7B6C6",bodyColor:"#EAF2FB",borderColor:"rgba(46,155,255,0.40)",borderWidth:1,padding:10,
            callbacks:{title:items=>items[0]?.label??"",
              label:ctx=>{const v=ctx.parsed.y;return`  ${ctx.dataset.label}: ${v!==null?v.toFixed(2)+" %":"—"}`;},
              labelTextColor:ctx=>ctx.dataset.borderColor}},
          zoom:{pan:{enabled:true,mode:"xy",threshold:10},
            zoom:{wheel:{enabled:true,mode:"xy"},pinch:{enabled:false},
              drag:{enabled:false},
              mode:"xy"}}},
        scales:{
          x:{afterBuildTicks:axis=>{const tks=axis.ticks;if(!tks.length)return;const toMin=l=>(l&&l.length>=5)?parseInt(l.slice(0,2),10)*60+parseInt(l.slice(3,5),10):null;const f=toMin(axis.getLabelForValue(tks[0].value)),lt=toMin(axis.getLabelForValue(tks[tks.length-1].value));const span=(f!=null&&lt!=null)?Math.max(1,Math.abs(lt-f)):60;const steps=[1,2,5,10,15,20,30,60,120,180];let step=180;for(const s of steps){if(span/s<=14){step=s;break;}}axis.ticks=tks.filter(tk=>{const m=toMin(axis.getLabelForValue(tk.value));return m!=null&&m%step===0;});},
            ticks:{color:"#8595A6",font:{size:11},maxRotation:0,autoSkip:false,
              callback:function(value){return this.getLabelForValue(value)||"";}},
            grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"}},
          y:{position:"left",min:0,max:100,
            ticks:{color:"#8595A6",font:{size:11},maxTicksLimit:8,callback:v=>v.toFixed(1)+"%"},
            grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
            title:{display:true,text:"Desbalanceamento (%)",color:"#A7B6C6",font:{size:11}}}}},
    });
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}};
  },[ready,inverters]);

  return(
    <div style={{position:"relative",width:"100%",height:"100%"}}>
      {!ready&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--color-text-tertiary)",fontSize:13}}>Carregando…</div>}
      <canvas ref={canvasRef} role="img" style={{cursor:"crosshair"}} onDoubleClick={()=>chartRef.current?.resetZoom()}/>
    </div>
  );
}

// ── Painel de Disponibilidade ─────────────────────────────────────────────────
const MONTH_FULL = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function invName(sn, map) { return (map&&map[sn]) || `SN ${String(sn).slice(-4)}`; }
function invColor(idx) { return PALETTE[idx % PALETTE.length]; }

// Eixo X em horário (HH:MM) com espaçamento adaptativo de ticks — usado por gráficos de
// série temporal intradiária (Combiners, curva de Geração), pra não empilhar labels.
function timeAxisScale() {
  return {
    afterBuildTicks: axis => {
      const tks = axis.ticks;
      if (!tks.length) return;
      const toMin = l => (l && l.length>=5) ? parseInt(l.slice(0,2),10)*60+parseInt(l.slice(3,5),10) : null;
      const f = toMin(axis.getLabelForValue(tks[0].value)), lt = toMin(axis.getLabelForValue(tks[tks.length-1].value));
      const span = (f!=null && lt!=null) ? Math.max(1,Math.abs(lt-f)) : 60;
      const steps = [1,2,5,10,15,20,30,60,120,180];
      let step = 180;
      for (const s of steps) { if (span/s<=14) { step=s; break; } }
      axis.ticks = tks.filter(tk => { const m=toMin(axis.getLabelForValue(tk.value)); return m!=null && m%step===0; });
    },
    ticks:{color:"#8595A6",font:{size:11},maxRotation:0,autoSkip:false,callback:function(value){return this.getLabelForValue(value)||"";}},
    grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
  };
}
// Cache em nível de módulo — sem isso, cada vez que o painel desmonta/remonta
// (trocar de aba e voltar) o mapa reiniciava vazio e o nome "SN ####" (fallback)
// piscava na tela até o fetch terminar de novo. `resetInverterMapCache` é chamado
// pelo botão "Atualizar" pra descartar um mapa que ficou incompleto por alguma falha.
let _inverterMapCache = null;
let _inverterMapPromise = null;
let _inverterMapForceRefresh = false;
// `refresh` força o back-end a revarrer a API do INGECON ao vivo (~40s) em vez de só ler o
// cache persistido — só deve acontecer quando o usuário pede via botão "Atualizar".
function resetInverterMapCache() { _inverterMapCache = null; _inverterMapPromise = null; _inverterMapForceRefresh = true; }
function useInverterMap(refreshTick, autoSyncTick) {
  const [map, setMap] = useState(_inverterMapCache || {});
  useEffect(()=>{
    if (_inverterMapCache) { setMap(_inverterMapCache); return; }
    if (!_inverterMapPromise) {
      const url = _inverterMapForceRefresh ? "/api/inverter-map?refresh=1" : "/api/inverter-map";
      _inverterMapForceRefresh = false;
      // Numa falha (rede, Supabase fora do ar etc.) NÃO grava cache vazio — isso travaria os
      // nomes em "SN ####" pra sempre, já que uma vez cacheado (mesmo vazio) nada tentaria de
      // novo sozinho. Em vez disso, descarta a promise (`_inverterMapPromise=null`) pra que a
      // próxima montagem/auto-sync tente buscar de novo.
      _inverterMapPromise = fetch(url)
        .then(r=>{ if(!r.ok) throw new Error(`Erro ${r.status}`); return r.json(); })
        .catch(err=>{ _inverterMapPromise=null; throw err; });
    }
    let cancelled=false;
    _inverterMapPromise
      .then(m=>{ _inverterMapCache=m; if(!cancelled) setMap(m); })
      .catch(()=>{ /* falha silenciosa — próxima montagem/auto-sync tenta de novo */ });
    return ()=>{ cancelled=true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[refreshTick]);

  // Auto-sync (a cada ~15min, roda sempre em segundo plano — ver useAutoSync/runAutoSync no
  // App): relê o cache já revalidado por runAutoSync, o que também recupera sozinho de uma
  // falha anterior — sem precisar clicar "Atualizar".
  const lastMapAutoTickRef = useRef(autoSyncTick);
  useEffect(()=>{
    if (autoSyncTick===lastMapAutoTickRef.current) return;
    lastMapAutoTickRef.current = autoSyncTick;
    if (_inverterMapCache) setMap(_inverterMapCache);
  },[autoSyncTick]);

  return map;
}

// ── Caches de dados em nível de módulo + auto-sync a cada 15min ─────────────────
// Mesma ideia do cache do mapa de inversores: sobrevivem a troca de aba, pra não
// recarregar do zero. Um agendador central (no componente App, sempre montado)
// busca os dados ~90s depois de cada marca de 15min (quando a API já tem a leitura
// nova) e guarda aqui; cada painel só relê o cache quando `autoSyncTick` muda —
// nenhum painel dispara fetch sozinho por causa do auto-sync.
let _genRowsCache = null;   // [{sn,date,eInjection,eAbsorption}] — /api/generation (últimos 30 dias)
let _pacCache = {};         // { [ymd]: {[boardId]: [{time,pac}]} } — /api/availability (Pac 15min), compartilhado entre Disponibilidade e a curva de Geração
let _combinerCache = {};    // { [ymd]: {[GId]: {time,idc[]}[]} } — /api/stringbox, já agrupado por GId

async function runAutoSync() {
  const dates = last30Dates();
  const today = dates[dates.length-1];
  const results = await Promise.allSettled([
    fetch(`/api/generation?from=${dates[0]}&to=${today}`),
    fetch(`/api/availability?date=${today}`),
    fetch(`/api/stringbox?date=${today}`),
    fetch(`/api/inverter-map`), // sem ?refresh=1 — só relê o cache persistido (rápido), nunca a varredura ao vivo
  ]);
  const [genRes, pacRes, sbRes, mapRes] = results;
  if (genRes.status==="fulfilled" && genRes.value.ok) {
    try { _genRowsCache = await genRes.value.json(); } catch { /* resposta inválida — mantém cache anterior */ }
  }
  if (pacRes.status==="fulfilled" && pacRes.value.ok) {
    try { _pacCache = { ..._pacCache, [today]: await pacRes.value.json() }; } catch { /* idem */ }
  }
  if (sbRes.status==="fulfilled" && sbRes.value.ok) {
    try { _combinerCache = { ..._combinerCache, [today]: groupStringboxByGId(await sbRes.value.json()) }; } catch { /* idem */ }
  }
  // Revalida o mapa BoardId→inversor a cada ciclo — se uma falha anterior tiver deixado o
  // cache vazio/incompleto, isso o recupera sozinho, sem precisar clicar "Atualizar".
  if (mapRes.status==="fulfilled" && mapRes.value.ok) {
    try { const m = await mapRes.value.json(); if (m && Object.keys(m).length) _inverterMapCache = m; } catch { /* idem */ }
  }
}

// Duas tentativas por marca de 15min do INGECON (13:00, 13:15, 13:30…): a primeira 1min
// depois (13:01:00) e a segunda mais 1min depois (13:02:00), pra garantir que pegou a
// leitura nova mesmo se a primeira tentativa ainda estivesse cedo demais.
const AUTO_SYNC_OFFSETS = [60*1000, 120*1000];
function useAutoSync() {
  const [tick, setTick] = useState(0);
  useEffect(()=>{
    let timer, cancelled=false;
    const QUARTER=15*60*1000;
    function nextRun(now) {
      const base = Math.floor(now/QUARTER)*QUARTER;
      for (const off of AUTO_SYNC_OFFSETS) { if (base+off>now) return base+off; }
      return base+QUARTER+AUTO_SYNC_OFFSETS[0];
    }
    function schedule() {
      const now=Date.now();
      const next=nextRun(now);
      timer=setTimeout(async()=>{
        await runAutoSync().catch(()=>{});
        if (!cancelled) { setTick(t=>t+1); schedule(); }
      }, next-now);
    }
    schedule();
    return ()=>{ cancelled=true; clearTimeout(timer); };
  },[]);
  return tick;
}

function AvailabilityPanel({ onLastUpdated, refreshTick, autoSyncTick }) {
  const invMap = useInverterMap(refreshTick, autoSyncTick);
  const dates = useMemo(()=>last30Dates(),[]);
  const today = dates[dates.length-1];
  const [viewMode, setViewMode] = useState("daily");
  const [selDate, setSelDate] = useState(today);
  const [selMonth, setSelMonth] = useState(today.slice(0,6));
  const [sampleCache, setSampleCache] = useState(()=>({..._pacCache})); // { [ymd]: {[sn]: {time,pac}[]} } — seedado do cache de módulo (compartilhado com a curva de Geração)
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({loaded:0,total:0});
  const [fatalError, setFatalError] = useState(null);

  const months = useMemo(()=>[...new Set(dates.map(d=>d.slice(0,6)))].sort(),[dates]);
  const monthIdx = months.indexOf(selMonth);

  const targetDates = useMemo(()=>
    viewMode==="daily" ? [selDate] : dates.filter(d=>d.startsWith(selMonth))
  ,[viewMode, selDate, selMonth, dates]);

  useEffect(()=>{
    let cancelled = false;
    const missing = targetDates.filter(d=>!sampleCache[d]);
    if (!missing.length) return;
    setLoading(true);
    setProgress({loaded:0, total:missing.length});
    (async()=>{
      let loaded=0;
      for (const d of missing) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/availability?date=${d}`);
          if (!res.ok) {
            const body = await res.json().catch(()=>({}));
            throw new Error(body.error || `Erro ${res.status} ao buscar ${d}`);
          }
          const data = await res.json();
          if (cancelled) return;
          _pacCache = { ..._pacCache, [d]: data };
          setSampleCache(prev=>({...prev,[d]:data}));
          if (d===today) onLastUpdated?.(new Date());
          const cacheStatus = res.headers.get("X-Cache");
          loaded++;
          setProgress({loaded, total:missing.length});
          if (cacheStatus!=="HIT" && d!==missing[missing.length-1]) {
            await new Promise(r=>setTimeout(r,3500));
          }
        } catch(err) {
          if (loaded===0) setFatalError(err.message);
          loaded++;
          setProgress({loaded, total:missing.length});
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return ()=>{ cancelled=true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[targetDates]);

  // Botão "Atualizar" (refreshTick) força revalidar "hoje" — nunca acontece sozinho,
  // pra não trocar dados debaixo de uma análise em andamento sem o usuário pedir.
  const lastAvailTickRef = useRef(refreshTick);
  useEffect(()=>{
    if (refreshTick===lastAvailTickRef.current) return;
    lastAvailTickRef.current = refreshTick;
    (async()=>{
      try {
        const res = await fetch(`/api/availability?date=${today}`);
        if (!res.ok) return;
        const data = await res.json();
        _pacCache = { ..._pacCache, [today]: data };
        setSampleCache(prev=>({...prev,[today]:data}));
        onLastUpdated?.(new Date());
      } catch { /* falha silenciosa — usuário pode tentar de novo */ }
    })();
  },[refreshTick, today, onLastUpdated]);

  // Auto-sync (a cada ~15min, roda sempre em segundo plano — ver useAutoSync no App):
  // só relê "hoje" do cache já atualizado por runAutoSync, sem novo fetch.
  const lastAvailAutoTickRef = useRef(autoSyncTick);
  useEffect(()=>{
    if (autoSyncTick===lastAvailAutoTickRef.current) return;
    lastAvailAutoTickRef.current = autoSyncTick;
    if (_pacCache[today]) { setSampleCache(prev=>({...prev,[today]:_pacCache[today]})); onLastUpdated?.(new Date()); }
  },[autoSyncTick, today, onLastUpdated]);

  // Início calculado por inversor individualmente (sem smart start global)

  // Disponibilidade diária
  const dailyAvail = useMemo(()=>{
    const samples = sampleCache[selDate];
    if (!samples) return [];
    return Object.entries(samples)
      .map(([sn,data])=>({ sn, name:invName(sn,invMap), ...calcDayAvail(data, detectInverterStart(data)) }))
      .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))
      .map((inv,i)=>({...inv, color:invColor(i)}));
  },[sampleCache, selDate, invMap]);

  // Disponibilidade mensal
  const monthlyAvail = useMemo(()=>{
    const monthDates = dates.filter(d=>d.startsWith(selMonth));
    const bySn = {};
    monthDates.forEach(d=>{
      const samples = sampleCache[d];
      if (!samples) return;
      Object.entries(samples).forEach(([sn,data])=>{
        const res = calcDayAvail(data, detectInverterStart(data));
        (bySn[sn] ??= []).push({date:d, availability:res.availability, stoppedMins:res.stoppedMins, stoppedHours:res.stoppedHours});
      });
    });
    return Object.entries(bySn)
      .map(([sn,dayBreakdown])=>{
        const totalStoppedH = dayBreakdown.reduce((s,x)=>s+x.stoppedHours,0);
        const predicted = dayBreakdown.length*12;
        const avail = predicted>0 ? Math.max(0,Math.min(100,(predicted-totalStoppedH)/predicted*100)) : 0;
        const nm = invName(sn,invMap);
        return { sn, name:nm, invKey:sn, displayName:nm,
          availability:avail, stoppedHours:totalStoppedH, days:dayBreakdown.length, dayBreakdown };
      })
      .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))
      .map((inv,i)=>({...inv, color:invColor(i)}));
  },[sampleCache, selMonth, dates, invMap]);

  const items = viewMode==="daily" ? dailyAvail : monthlyAvail;
  const dateIdx = dates.indexOf(selDate);
  const goPrevDay = () => { if(dateIdx>0) setSelDate(dates[dateIdx-1]); };
  const goNextDay = () => { if(dateIdx<dates.length-1) setSelDate(dates[dateIdx+1]); };
  const noData = !items.length && !loading;

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",padding:"10px 16px 8px",minHeight:0}}>
      {/* ── Header ── */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexShrink:0,flexWrap:"wrap"}}>
        {/* Toggle */}
        <div style={{display:"flex",gap:2,background:"var(--color-background-secondary)",padding:3,borderRadius:8,flexShrink:0}}>
          {[{id:"daily",icon:"ti-calendar-day",label:"Diária"},{id:"monthly",icon:"ti-calendar-month",label:"Mensal"}].map(v=>(
            <button key={v.id} onClick={()=>setViewMode(v.id)}
              style={{padding:"5px 14px",fontSize:13,cursor:"pointer",borderRadius:6,border:"none",
                background:viewMode===v.id?"#1656d6":"transparent",
                color:viewMode===v.id?"#fff":"var(--color-text-secondary)",
                fontWeight:viewMode===v.id?600:400,display:"flex",alignItems:"center",gap:5,transition:"all 0.15s"}}>
              <i className={`ti ${v.icon}`} style={{fontSize:13}}/>{v.label}
            </button>
          ))}
        </div>

        {/* Contexto */}
        {viewMode==="daily"&&(
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={goPrevDay} disabled={dateIdx<=0}
              style={{background:"none",border:"none",cursor:dateIdx>0?"pointer":"default",fontSize:15,
                color:dateIdx>0?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-left"/>
            </button>
            <span style={{fontSize:13,fontWeight:600,minWidth:88,textAlign:"center",fontFamily:"var(--font-mono)"}}>
              {fmtYmd(selDate)}
            </span>
            <button onClick={goNextDay} disabled={dateIdx>=dates.length-1}
              style={{background:"none",border:"none",cursor:dateIdx<dates.length-1?"pointer":"default",fontSize:15,
                color:dateIdx<dates.length-1?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-right"/>
            </button>
          </div>
        )}
        {viewMode==="monthly"&&(
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={()=>{if(monthIdx>0)setSelMonth(months[monthIdx-1]);}}
              disabled={monthIdx<=0}
              style={{background:"none",border:"none",cursor:monthIdx>0?"pointer":"default",
                fontSize:14,color:monthIdx>0?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-left"/>
            </button>
            <span style={{fontSize:13,fontWeight:600,minWidth:130,textAlign:"center"}}>
              {selMonth?`${MONTH_FULL[parseInt(selMonth.slice(4,6))-1]} ${selMonth.slice(0,4)}`:"—"}
            </span>
            <button onClick={()=>{if(monthIdx<months.length-1)setSelMonth(months[monthIdx+1]);}}
              disabled={monthIdx>=months.length-1}
              style={{background:"none",border:"none",cursor:monthIdx<months.length-1?"pointer":"default",
                fontSize:14,color:monthIdx<months.length-1?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-right"/>
            </button>
            {monthlyAvail.length>0&&<span style={{fontSize:13,color:"var(--color-text-tertiary)"}}>{monthlyAvail[0]?.days}d</span>}
          </div>
        )}

        {loading&&(
          <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"var(--color-text-tertiary)"}}>
            <div style={{width:80,height:5,borderRadius:3,background:"var(--color-background-secondary)",overflow:"hidden"}}>
              <div style={{width:`${(progress.loaded/Math.max(1,progress.total)*100).toFixed(0)}%`,height:"100%",
                background:"#1656d6",transition:"width 0.3s"}}/>
            </div>
            <span>carregando {progress.loaded}/{progress.total}</span>
          </div>
        )}

      </div>

      {fatalError?(
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
          color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center"}}>
          <div>
            <i className="ti ti-plug-connected-x" style={{fontSize:40,display:"block",marginBottom:8}}/>
            {fatalError}
          </div>
        </div>
      ):noData?(
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
          color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center"}}>
          <div>
            <i className="ti ti-chart-bar-off" style={{fontSize:40,display:"block",marginBottom:8}}/>
            {viewMode==="daily"?"Sem dados para este dia":"Nenhum dado para o mês selecionado"}
          </div>
        </div>
      ):(
        <div style={{flex:1,display:"flex",gap:0,overflow:"hidden",minHeight:0}}>

          {/* ── Coluna 1: Barras de disponibilidade ── */}
          <div style={{flex:"0 0 64%",display:"flex",flexDirection:"column",overflow:"hidden",paddingRight:8}}>
            <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",textTransform:"uppercase",
              letterSpacing:"0.05em",marginBottom:8,flexShrink:0}}>
              {viewMode==="daily"?"Disponibilidade Diária (12h previstas)":"Disponibilidade Mensal"}
            </div>

            {/* Cabeçalho das linhas de referência */}
            <div style={{position:"relative",marginLeft:66,marginRight:46,height:14,flexShrink:0}}>
              {[0,25,50,75,90,100].map(p=>(
                <span key={p} style={{position:"absolute",left:`${p}%`,transform:"translateX(-50%)",
                  fontSize:13,color:"var(--color-text-tertiary)"}}>{p}%</span>
              ))}
            </div>

            <div style={{overflowY:"auto",flex:1,paddingRight:4}}>
              {items.map((inv)=>(
                <div key={inv.invKey||inv.id} style={{marginBottom:viewMode==="monthly"?4:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    {/* Label inversor */}
                    <div style={{width:66,flexShrink:0,display:"flex",alignItems:"center",gap:4}}>
                      <span style={{width:7,height:7,borderRadius:"50%",background:inv.color,flexShrink:0}}></span>
                      <span style={{fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",
                        whiteSpace:"nowrap",color:"var(--color-text-primary)"}}
                        title={inv.displayName||inv.name}>{inv.displayName||inv.name}</span>
                    </div>
                    {/* Barra */}
                    <div style={{flex:1,position:"relative",height:viewMode==="monthly"?16:24,background:"var(--color-background-secondary)",
                      borderRadius:5,overflow:"hidden"}}>
                      {[25,50,75].map(p=>(
                        <div key={p} style={{position:"absolute",left:`${p}%`,top:0,bottom:0,
                          width:1,background:"rgba(0,0,0,0.08)",zIndex:1,pointerEvents:"none"}}></div>
                      ))}
                      {/* Linha 90% */}
                      <div style={{position:"absolute",left:"90%",top:0,bottom:0,
                        width:1.5,background:"rgba(76,175,80,0.5)",zIndex:1,pointerEvents:"none"}}></div>
                      <div style={{
                        position:"absolute",left:0,top:0,bottom:0,
                        width:`${Math.min(100,inv.availability??0).toFixed(1)}%`,
                        background:availColor(inv.availability),opacity:0.88,
                        borderRadius:5,zIndex:2,display:"flex",alignItems:"center",
                        paddingLeft:8,transition:"width 0.4s ease",
                      }}>
                        {inv.availability>=18&&(
                          <span style={{fontSize:13,color:"#fff",fontWeight:700,whiteSpace:"nowrap"}}>
                            {(inv.availability??0).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Valor & parado */}
                    <div style={{width:56,flexShrink:0,textAlign:"right"}}>
                      {inv.availability<18&&(
                        <div style={{fontSize:13,fontWeight:700,color:availColor(inv.availability),lineHeight:1.2}}>
                          {(inv.availability??0).toFixed(1)}%
                        </div>
                      )}
                      <div style={{fontSize:13,color:"var(--color-text-tertiary)",lineHeight:1.3}}>
                        {fmtMins(
                          viewMode==="daily"
                            ? (inv.stoppedMins ?? 0)
                            : Math.round((inv.stoppedHours ?? 0) * 60)
                        )} parado
                      </div>
                    </div>
                  </div>

                  {/* Breakdown diário (mensal) */}
                  {viewMode==="monthly"&&inv.dayBreakdown&&(
                    <div style={{marginLeft:72,marginTop:2,display:"flex",flexWrap:"wrap",gap:2}}>
                      {inv.dayBreakdown.map(db=>(
                        <span key={db.date} title={`${db.date}: ${(db.availability??0).toFixed(1)}% (${fmtMins(db.stoppedMins)} parado)`}
                          style={{fontSize:13,padding:"1px 5px",borderRadius:3,cursor:"default",
                            background:`${availColor(db.availability)}1A`,
                            color:availColor(db.availability),
                            border:`1px solid ${availColor(db.availability)}44`}}>
                          {db.date.slice(6,8)} {(db.availability??0).toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ── Divisor ── */}
          <div style={{width:1,background:"var(--color-border-tertiary)",flexShrink:0,margin:"0 2px"}}></div>

          {/* ── Coluna 2: Intervalos de parada (diária) ou resumo mensal ── */}
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",paddingLeft:12}}>
            {viewMode==="daily"?(
              <>
                <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",textTransform:"uppercase",
                  letterSpacing:"0.05em",marginBottom:8,flexShrink:0}}>
                  Intervalos sem geração (05:30 – 17:30)
                </div>
                <div style={{overflowY:"auto",flex:1,display:"flex",flexDirection:"column",gap:4}}>
                  {dailyAvail.map(inv=>(
                    <div key={inv.id||inv.invKey}
                      style={{background:"var(--color-background-secondary)",borderRadius:6,
                        padding:"5px 8px",borderLeft:`3px solid ${availColor(inv.availability)}`}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:inv.intervals.length?3:0}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:inv.color,flexShrink:0}}></span>
                        <span style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)",
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}
                          title={inv.displayName||inv.name}>{inv.displayName||inv.name}</span>
                        <span style={{fontSize:13,fontWeight:700,color:availColor(inv.availability),flexShrink:0}}>
                          {(inv.availability??0).toFixed(1)}%
                        </span>
                      </div>
                      {!inv.intervals.length?(
                        <div style={{fontSize:13,color:"#4CAF50",display:"flex",alignItems:"center",gap:4}}>
                          <i className="ti ti-check" style={{fontSize:13}}/>Nenhuma parada relevante
                          {inv.rawIntervals?.length>0&&(
                            <span style={{fontSize:13,color:"var(--color-text-tertiary)",marginLeft:4}}>
                              ({inv.rawIntervals.length} ignorada(s): ≤{MIN_STOP_MINS}min ou fim do dia)
                            </span>
                          )}
                        </div>
                      ):(
                        <div style={{display:"flex",flexDirection:"column",gap:2}}>
                          {inv.intervals.map((iv,idx)=>(
                            <div key={idx} style={{display:"flex",alignItems:"center",gap:6,fontSize:13,
                              color:"var(--color-text-secondary)"}}>
                              <i className="ti ti-clock-off" style={{fontSize:13,color:"#F44336",flexShrink:0}}/>
                              <span style={{fontFamily:"var(--font-mono)"}}>{iv.start} – {iv.end}</span>
                              <span style={{color:"var(--color-text-tertiary)",flexShrink:0}}>({fmtMins(iv.mins)})</span>
                            </div>
                          ))}
                          <div style={{fontSize:13,color:"var(--color-text-tertiary)",marginTop:3,paddingTop:3,
                            borderTop:"0.5px solid var(--color-border-tertiary)",display:"flex",justifyContent:"space-between"}}>
                            <span>Total parado: <strong style={{color:availColor(inv.availability)}}>{fmtMins(inv.stoppedMins)}</strong></span>
                          {inv.rawIntervals?.length > inv.intervals.length && (
                              <span style={{fontSize:13,color:"var(--color-text-tertiary)"}}>
                                +{inv.rawIntervals.length - inv.intervals.length} ignorada(s) (≤{MIN_STOP_MINS}min ou fim do dia)
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ):(
              <>
                <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",textTransform:"uppercase",
                  letterSpacing:"0.05em",marginBottom:8,flexShrink:0}}>
                  Resumo Mensal
                </div>
                <div style={{overflowY:"auto",flex:1}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                    <thead style={{position:"sticky",top:0,zIndex:1,background:"var(--color-background-primary)"}}>
                      <tr>
                        {["Inversor","Dias","Total parado","Disp. Mensal"].map(h=>(
                          <th key={h} style={{padding:"3px 8px",textAlign:h==="Inversor"?"left":"right",
                            fontWeight:600,fontSize:13,color:"var(--color-text-secondary)",
                            borderBottom:"0.5px solid var(--color-border-tertiary)"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyAvail.map((inv,i)=>(
                        <tr key={inv.invKey} style={{background:i%2===1?"var(--color-background-secondary)":"transparent"}}>
                          <td style={{padding:"2px 8px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:5}}>
                              <span style={{width:7,height:7,borderRadius:"50%",background:inv.color,flexShrink:0}}></span>
                              <span style={{fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:120}}
                                title={inv.displayName}>{inv.displayName}</span>
                            </div>
                          </td>
                          <td style={{padding:"2px 8px",textAlign:"right",fontSize:13,color:"var(--color-text-tertiary)"}}>{inv.days}</td>
                          <td style={{padding:"2px 8px",textAlign:"right",fontSize:13,fontFamily:"var(--font-mono)",color:"var(--color-text-secondary)"}}>
                            {fmtMins(Math.round(inv.stoppedHours*60))}
                          </td>
                          <td style={{padding:"2px 8px",textAlign:"right",fontSize:13,fontWeight:700,
                            color:availColor(inv.availability),fontFamily:"var(--font-mono)"}}>
                            {(inv.availability??0).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Ordenação de tabelas ──────────────────────────────────────────────────────
// Hook: retorna [sortKey, sortDir, toggle(key), sortFn]
// Ciclo: asc(↑) → desc(↓) → alpha(AZ) → asc
function useSortableTable(defaultKey="", defaultDir="asc") {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);
  const toggle = useCallback(key => {
    setSortKey(prev => {
      if (prev !== key) { setSortDir("asc"); return key; }
      setSortDir(d => d==="asc" ? "desc" : d==="desc" ? "alpha" : "asc");
      return key;
    });
  }, []);
  return { sortKey, sortDir, toggle };
}

function applySortDir(rows, sortKey, sortDir) {
  if (!sortKey) return rows;
  return [...rows].sort((a, b) => {
    if (sortDir === "alpha") {
      const an = String(a.name ?? a.invName ?? "");
      const bn = String(b.name ?? b.invName ?? "");
      return an.localeCompare(bn, undefined, {numeric:true, sensitivity:"base"});
    }
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av==="number" && typeof bv==="number"
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, {numeric:true, sensitivity:"base"});
    return sortDir === "asc" ? cmp : -cmp;
  });
}

function SortTh({ label, sortKey, col, sortDir, onSort, align="right" }) {
  const active = sortKey === col;
  const icon   = !active ? "↕" : sortDir==="asc" ? "↑" : sortDir==="desc" ? "↓" : "AZ";
  const tip    = !active ? "1°clique: menor→maior"
    : sortDir==="asc"  ? "2°clique: maior→menor"
    : sortDir==="desc" ? "3°clique: ordem A→Z / 0→9"
    : "1°clique: menor→maior";
  return (
    <th onClick={() => onSort(col)} title={tip}
      style={{padding:"4px 6px", textAlign:align, fontWeight:600, fontSize:11,
        color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        borderBottom:"0.5px solid var(--color-border-tertiary)",
        cursor:"pointer", userSelect:"none", whiteSpace:"nowrap", transition:"color 0.12s"}}>
      {label}
      <span style={{marginLeft:3, fontSize:11, opacity:active?1:0.25,
        color:active?"#1656d6":"inherit", fontFamily:"monospace"}}>
        {icon}
      </span>
    </th>
  );
}

// ── VarSelect ─────────────────────────────────────────────────────────────────
function VarSelect({ id, value, onChange, label, swatchColor, dashPattern, optional }) {
  return(
    <div style={{display:"flex",alignItems:"center",gap:5}}>
      <svg width="18" height="10" style={{flexShrink:0}}>
        <line x1="0" y1="5" x2="18" y2="5" stroke={swatchColor} strokeWidth="2.5"
          strokeDasharray={(dashPattern||[]).join(",")}/>
      </svg>
      <label htmlFor={id} style={{fontSize:13,color:"var(--color-text-secondary)",flexShrink:0}}>{label}</label>
      <select id={id} value={value} onChange={e=>onChange(e.target.value)}
        style={{fontSize:12,maxWidth:170,padding:"3px 8px",borderRadius:7,cursor:"pointer",outline:"none",
          background:"#ffffff",color:"#182449",
          border:`1px solid ${value!==NONE?swatchColor+"99":"rgba(24,36,73,0.14)"}`}}>
        {optional&&<option value={NONE} style={{background:"#ffffff",color:"#182449"}}>— nenhuma —</option>}
        {VAR_GROUPS.map(g=>(
          <optgroup key={g.label} label={g.label} style={{background:"#ffffff",color:"#5c6788"}}>
            {g.vars.map(v=><option key={v.key} value={v.key} style={{background:"#ffffff",color:"#182449"}}>{v.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ── Calendário ────────────────────────────────────────────────────────────────
const WD=["D","S","T","Q","Q","S","S"];
function MiniCalendar({ datesSet, selectedDate, onSelect, invColors }) {
  const today=new Date();
  const [vy,setVy]=useState(()=>selectedDate?parseInt(selectedDate.slice(0,4)):today.getFullYear());
  const [vm,setVm]=useState(()=>selectedDate?parseInt(selectedDate.slice(5,7))-1:today.getMonth());

  // Segue o selectedDate se mudar para um mês diferente do visível
  useEffect(()=>{
    if(!selectedDate) return;
    const y=parseInt(selectedDate.slice(0,4));
    const m=parseInt(selectedDate.slice(5,7))-1;
    if(y!==vy||m!==vm){ setVy(y); setVm(m); }
  },[selectedDate]); // eslint-disable-line
  const first=new Date(vy,vm,1).getDay();
  const days=new Date(vy,vm+1,0).getDate();
  const cells=[...Array(first).fill(null),...Array.from({length:days},(_,i)=>i+1)];
  while(cells.length%7) cells.push(null);
  const todayStr=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  const MSHORT=["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return(
    <div style={{padding:"8px 10px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
        <button onClick={()=>{if(vm===0){setVy(y=>y-1);setVm(11);}else setVm(m=>m-1);}}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"var(--color-text-secondary)",padding:"2px 4px"}}>
          <i className="ti ti-chevron-left"/>
        </button>
        <span style={{fontWeight:600,fontSize:13,color:"var(--color-text-primary)"}}>{MSHORT[vm]} {vy}</span>
        <button onClick={()=>{if(vm===11){setVy(y=>y+1);setVm(0);}else setVm(m=>m+1);}}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"var(--color-text-secondary)",padding:"2px 4px"}}>
          <i className="ti ti-chevron-right"/>
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1}}>
        {WD.map((w,i)=>(
          <div key={i} style={{textAlign:"center",fontSize:8,fontWeight:700,color:"var(--color-text-tertiary)",padding:"2px 0",textTransform:"uppercase"}}>{w}</div>
        ))}
        {cells.map((day,i)=>{
          if(!day) return<div key={`e${i}`}></div>;
          const ds=`${vy}-${String(vm+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
          const has=datesSet.has(ds),sel=ds===selectedDate,tod=ds===todayStr;
          const dots=invColors[ds]||[];
          return(
            <div key={ds} onClick={()=>has&&onSelect(ds)}
              style={{textAlign:"center",borderRadius:5,padding:"3px 1px 2px",cursor:has?"pointer":"default",
                background:sel?"#1656d6":tod?"rgba(46,155,255,0.1)":has?"rgba(0,0,0,0.035)":"transparent",
                border:tod&&!sel?"1px solid rgba(46,155,255,0.35)":"1px solid transparent",
                transition:"background 0.1s"}}
              onMouseEnter={e=>{if(has&&!sel)e.currentTarget.style.background="rgba(46,155,255,0.18)";}}
              onMouseLeave={e=>{if(has&&!sel)e.currentTarget.style.background=has?"rgba(0,0,0,0.035)":"transparent";}}>
              <div style={{fontSize:13,fontWeight:sel||tod?700:has?500:400,lineHeight:1.2,
                color:sel?"#fff":tod?"#1B6FC9":has?"var(--color-text-primary)":"var(--color-text-tertiary)"}}>{day}</div>
              {has&&dots.length>0&&(
                <div style={{display:"flex",justifyContent:"center",gap:1,marginTop:1}}>
                  {dots.slice(0,4).map((c,ii)=>(
                    <span key={ii} style={{width:3,height:3,borderRadius:"50%",
                      background:sel?"rgba(255,255,255,0.8)":c,display:"block"}}></span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Dashboard principal ───────────────────────────────────────────────────────
const MonitoramentoInner = forwardRef(function MonitoramentoInner({ activeTab, onRefreshStateChange }, ref) {
  const [allData,      setAllData]      = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [vars,         setVars]         = useState(["pac",NONE,NONE,NONE]);
  const [selectedTime, setSelectedTime] = useState(null);
  const [isDragging,   setIsDragging]   = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [errors,       setErrors]       = useState([]);
  const [showStats,    setShowStats]    = useState(true);
  const [hidden,       setHidden]       = useState(new Set());
  const [lastUpdated,  setLastUpdated]  = useState(null); // Date da última leitura da API (avail/gen/combiners)
  const [refreshTick,  setRefreshTick]  = useState(0); // incrementa só quando o usuário clica "Atualizar"
  const [refreshing,   setRefreshing]   = useState(false);
  const autoSyncTick = useAutoSync(); // incrementa sozinho a cada ~15min, sempre (independe da aba ativa)
  const fileRef = useRef();

  useEffect(()=>{ setLastUpdated(null); },[activeTab]);

  const handleRefresh = () => {
    resetInverterMapCache();
    setRefreshTick(t=>t+1);
    setRefreshing(true);
    setTimeout(()=>setRefreshing(false), 1500); // só pro ícone girar um instante, feedback visual
  };

  // O botão de "Atualizar" mora na barra azul do dashboard principal (fora
  // deste componente) pra não ocupar uma faixa branca inteira só pra ele —
  // expõe o disparo via ref e avisa o pai do estado atual (girando? quando
  // foi a última leitura? faz sentido mostrar nesta aba?) pra ele desenhar
  // o botão.
  useImperativeHandle(ref, () => ({ refresh: handleRefresh }), [handleRefresh]);
  const showRefresh = activeTab==="avail" || activeTab==="gen" || activeTab==="combiners";
  useEffect(() => {
    onRefreshStateChange?.({ refreshing, lastUpdated, showRefresh });
  }, [refreshing, lastUpdated, showRefresh, onRefreshStateChange]);

  const [sideW,  onSideDrag]   = useDivider(255,180,420,"horizontal");
  const [statsH, onStatsDrag]  = useDivider(190,80,440,"vertical");

  // Datas disponíveis
  const datesSet = useMemo(()=>{
    const s=new Set();
    Object.values(allData).forEach(inv=>Object.keys(inv.dates).forEach(d=>s.add(d)));
    return s;
  },[allData]);
  const sortedDates=useMemo(()=>[...datesSet].sort(),[datesSet]);

  // Cores por data para calendário
  const calDotColors=useMemo(()=>{
    const map={};
    sortedDates.forEach(d=>{
      map[d]=Object.values(allData).filter(inv=>inv.dates[d]).map(inv=>inv.color);
    });
    return map;
  },[allData,sortedDates]);

  // Inversores do dia selecionado
  const inverters=useMemo(()=>{
    if(!selectedDate) return[];
    return Object.values(allData)
      .filter(inv=>inv.dates[selectedDate])
      .map(inv=>({
        id:`${inv.invKey}-${selectedDate}`,
        invKey:inv.invKey,
        name:inv.displayName||inv.invKey,
        displayName:inv.displayName||inv.invKey,
        color:inv.color,paletteIdx:inv.paletteIdx,
        visible:!hidden.has(inv.invKey),
        data:inv.dates[selectedDate],
      }));
  },[allData,selectedDate,hidden]);

  // Carregar arquivos
  const addFiles=useCallback(async(files)=>{
    setLoading(true);setErrors([]);
    const errs=[];
    for(const file of Array.from(files)){
      const ext=file.name.split(".").pop().toLowerCase();
      if(ext!=="xlsx"&&ext!=="xls"){errs.push(`"${file.name}": use .xlsx`);continue;}
      try{
        const sheets=await parseXLSXMultiSheet(file);
        if(!sheets.length){errs.push(`"${file.name}": nenhuma planilha com data válida`);continue;}
        setAllData(prev=>{
          const next={...prev};
          sheets.forEach(({invKey,displayName,date,data})=>{
            if(!next[invKey]){
              const idx=Object.keys(next).length%PALETTE.length;
              next[invKey]={invKey,displayName,color:varColor(idx,0),paletteIdx:idx,dates:{}};
            }
            next[invKey]={...next[invKey],dates:{...next[invKey].dates,[date]:data}};
          });
          return next;
        });
        // Navega sempre para a data mais recente nos arquivos carregados
        const newDates = [...new Set(sheets.map(s=>s.date).filter(Boolean))].sort();
        if (newDates.length) setSelectedDate(prev => {
          // Mantém data mais recente entre a atual e as novas
          return (!prev || newDates.at(-1) > prev) ? newDates.at(-1) : prev;
        });
      }catch(err){errs.push(`"${file.name}": ${err.message}`);}
    }
    if(errs.length) setErrors(errs);
    setLoading(false);
  },[]);

  const onDrop=useCallback(e=>{e.preventDefault();setIsDragging(false);addFiles(e.dataTransfer.files);},[addFiles]);

  // Navegação de datas
  const curIdx=selectedDate?sortedDates.indexOf(selectedDate):-1;
  const prevDate=()=>{if(curIdx>0){setSelectedDate(sortedDates[curIdx-1]);setSelectedTime(null);}};
  const nextDate=()=>{if(curIdx<sortedDates.length-1){setSelectedDate(sortedDates[curIdx+1]);setSelectedTime(null);}};

  // Visibilidade
  const toggleInv=invKey=>setHidden(prev=>{const n=new Set(prev);n.has(invKey)?n.delete(invKey):n.add(invKey);return n;});
  const toggleAll=()=>{
    const ks=Object.keys(allData);
    setHidden(ks.some(k=>!hidden.has(k))?new Set(ks):new Set());
  };
  const clearAll=()=>{setAllData({});setSelectedDate(null);setSelectedTime(null);setHidden(new Set());setErrors([]);};
  const toggleLegend=invKey=>{
    const visKeys=Object.keys(allData).filter(k=>!hidden.has(k));
    if(hidden.has(invKey)){setHidden(prev=>{const n=new Set(prev);n.delete(invKey);return n;});}
    else if(visKeys.length>1){setHidden(new Set(Object.keys(allData).filter(k=>k!==invKey)));}
    else{setHidden(new Set());}
  };

  const setVar=(vi,key)=>setVars(prev=>prev.map((k,i)=>i===vi?key:k));
  const visible       = inverters.filter(i=>i.visible);
  const activeVars    = vars.filter(k=>k!==NONE);
  const selectorColors= [0,1,2,3].map(vi=>varColor(0,vi));
  const activeUnits   = [...new Set(activeVars.map(k=>VAR_MAP[k]?.unit??""))];
  const dualAxis      = activeUnits.length>1;
  const hasData       = Object.keys(allData).length>0;

  // Estatísticas (só nas abas var/imbalance)
  const stats=useMemo(()=>inverters.map(inv=>({
    ...inv,
    varStats:activeVars.map(key=>{
      const vals=(inv.data||[]).map(r=>r[key]).filter(v=>v!==null&&isFinite(v));
      if(!vals.length) return{key,min:null,max:null,avg:null};
      return{key,min:Math.min(...vals),max:Math.max(...vals),avg:vals.reduce((a,b)=>a+b,0)/vals.length};
    }),
  })),[inverters,activeVars.join(",")]);

  // Snapshot
  const snapshot=useMemo(()=>{
    if(!selectedTime||!inverters.length||!activeVars.length) return null;
    return inverters.map(inv=>{
      const row=(inv.data||[]).find(r=>r.time===selectedTime);
      return{...inv,values:activeVars.map(key=>({key,value:row?row[key]:null}))};
    });
  },[selectedTime,inverters,activeVars.join(",")]);

  // Desbalanceamento
  const IMBST="06:30",IMBEN="17:00";
  const imbalanceData=useMemo(()=>inverters.map(inv=>{
    let atPoint=null;
    if(selectedTime){
      const row=(inv.data||[]).find(r=>r.time===selectedTime);
      if(row&&row.pvbus!==null&&row.nvbus!==null){
        const s=row.pvbus+row.nvbus;atPoint=s!==0?Math.abs((row.pvbus-row.nvbus)/s)*100:0;
      }
    }
    const vals=(inv.data||[]).filter(r=>r.time>=IMBST&&r.time<=IMBEN&&r.pvbus!==null&&r.nvbus!==null)
      .map(r=>{const s=r.pvbus+r.nvbus;return s!==0?Math.abs((r.pvbus-r.nvbus)/s)*100:0;});
    return{...inv,atPoint,min:vals.length?Math.min(...vals):null,max:vals.length?Math.max(...vals):null,
      avg:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null};
  }),[selectedTime,inverters]);

  const fmt=v=>v!==null?Number(v).toFixed(3):"—";
  const fmtPct=v=>v!==null?v.toFixed(2)+" %":"—";
  const alertC=v=>v===null?"var(--color-text-tertiary)":v<35?"#4CAF50":v<70?"#FF9800":"#F44336";

  const showFileTab = activeTab==="vars" || activeTab==="imbalance";
  const showBottomPanel = showFileTab && stats.length>0;

  return(
    <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:0,overflow:"hidden",fontFamily:"inherit",
      background:P.page,
      "--color-background-primary":P.chromeCard,
      "--color-background-secondary":P.chromeBorderSoft,
      "--color-background-danger":"#fdeceb",
      "--color-text-primary":P.chromeText,
      "--color-text-secondary":P.chromeMuted,
      "--color-text-tertiary":"#8b96b8",
      "--color-text-danger":"#dc2626",
      "--color-border-tertiary":P.chromeBorderSoft,
      "--color-border-secondary":P.chromeBorder}}>

      {/* ── Barras de rolagem: ocultas por padrão, aparecem ao passar o cursor ── */}
      <style dangerouslySetInnerHTML={{__html:`
        .sdm-monitoramento ::-webkit-scrollbar{width:10px;height:10px;}
        .sdm-monitoramento ::-webkit-scrollbar-track{background:transparent;}
        .sdm-monitoramento ::-webkit-scrollbar-corner{background:transparent;}
        .sdm-monitoramento ::-webkit-scrollbar-thumb{
          background-color:transparent;border-radius:8px;
          border:2px solid transparent;background-clip:content-box;
          transition:background-color .2s ease;
        }
        .sdm-monitoramento:hover ::-webkit-scrollbar-thumb{background-color:rgba(24,36,73,.22);background-clip:content-box;}
        .sdm-monitoramento ::-webkit-scrollbar-thumb:hover{background-color:rgba(24,36,73,.40);background-clip:content-box;}
        @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
      `}}/>

      {/* ── Corpo principal ── */}
      <div style={{display:"flex",flex:1,overflow:"hidden",minHeight:0}}>

      {/* ── Sidebar (só nas abas com upload de .xlsx) ── */}
      {showFileTab&&(<>
      <aside style={{width:sideW,flexShrink:0,display:"flex",flexDirection:"column",
        background:"var(--color-background-primary)",
        borderRight:"0.5px solid var(--color-border-tertiary)",
        overflow:"hidden",minWidth:180,maxWidth:420}}>

        {/* Inversores — flex:1, lista scrollável */}
        <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,
          overflow:"hidden",borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
          <div style={{padding:"8px 10px 5px",flexShrink:0,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:600,fontSize:13,color:"var(--color-text-primary)"}}>Inversores</span>
            {hasData&&(
              <div style={{display:"flex",gap:5}}>
                <button onClick={toggleAll} style={{fontSize:13,padding:"2px 7px",cursor:"pointer",
                  borderRadius:5,border:"0.5px solid var(--color-border-secondary)",
                  background:"var(--color-background-secondary)"}}>
                  {visible.length>0?"Ocultar":"Mostrar"}
                </button>
                <button onClick={clearAll} style={{fontSize:13,padding:"2px 7px",cursor:"pointer",
                  borderRadius:5,border:"0.5px solid var(--color-border-secondary)",
                  background:"var(--color-background-secondary)",color:"var(--color-text-danger)"}}>
                  Limpar
                </button>
              </div>
            )}
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"0 6px 6px"}}>
            {hasData?Object.values(allData).map(inv=>{
              const isHidden=hidden.has(inv.invKey);
              const nDays=Object.keys(inv.dates).length;
              return(
                <div key={inv.invKey} onClick={()=>toggleLegend(inv.invKey)}
                  title={isHidden?"Ativar":Object.keys(allData).filter(k=>!hidden.has(k)).length>1?"Isolar":"Mostrar todos"}
                  style={{display:"flex",alignItems:"center",gap:6,padding:"3px 5px",borderRadius:5,
                    cursor:"pointer",opacity:isHidden?0.3:1,
                    background:isHidden?"transparent":"rgba(0,0,0,0.025)",transition:"opacity 0.15s"}}>
                  <div style={{display:"flex",flexDirection:"column",gap:1.5,flexShrink:0}}>
                    {(activeVars.length>0?activeVars:["pac"]).slice(0,2).map((_,vi)=>(
                      <svg key={vi} width="18" height="6" style={{flexShrink:0}}>
                        <line x1="0" y1="3" x2="18" y2="3" stroke={varColor(inv.paletteIdx,vi)}
                          strokeWidth="2" strokeDasharray={DASH_PATTERNS[vi].join(",")}/>
                      </svg>
                    ))}
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:500,overflow:"hidden",
                    textOverflow:"ellipsis",whiteSpace:"nowrap",
                    color:isHidden?"var(--color-text-tertiary)":"var(--color-text-primary)"}}
                    title={inv.displayName||inv.invKey}>{inv.displayName||inv.invKey}</span>
                  <span style={{fontSize:13,color:"var(--color-text-tertiary)",flexShrink:0}}>{nDays}d</span>
                  <button onClick={e=>{e.stopPropagation();toggleInv(inv.invKey);}}
                    style={{background:"none",border:"none",cursor:"pointer",fontSize:13,
                      color:"var(--color-text-tertiary)",padding:1,lineHeight:1,flexShrink:0}}>
                    <i className={`ti ti-eye${isHidden?"-off":""}`}/>
                  </button>
                </div>
              );
            }):(
              <div style={{padding:"14px 6px",fontSize:13,color:"var(--color-text-tertiary)",
                textAlign:"center",lineHeight:1.7}}>
                Arraste um .xlsx<br/>para começar
              </div>
            )}
          </div>
        </div>

        {/* ── Calendário (fixo) ── */}
        <div style={{flexShrink:0,borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
          {!hasData?(
            <div style={{padding:"8px 12px",textAlign:"center",
              color:"var(--color-text-tertiary)",fontSize:13,lineHeight:1.5}}>
              Cada .xlsx = 1 inversor<br/>cada planilha = 1 dia
            </div>
          ):(
            <MiniCalendar datesSet={datesSet} selectedDate={selectedDate}
              onSelect={d=>{setSelectedDate(d);setSelectedTime(null);}}
              invColors={calDotColors}/>
          )}
        </div>

        {/* ── Upload (fixo no fundo) ── */}
        <div style={{flexShrink:0}}>
          {/* Inversores */}
          <div onDragOver={e=>{e.preventDefault();setIsDragging(true);}}
            onDragLeave={()=>setIsDragging(false)} onDrop={onDrop}
            onClick={()=>fileRef.current?.click()}
            style={{margin:"6px 8px 3px",padding:"7px 8px",textAlign:"center",cursor:"pointer",
              border:`1.5px dashed ${isDragging?"#1656d6":"var(--color-border-secondary)"}`,
              borderRadius:6,
              background:isDragging?"rgba(46,155,255,0.06)":"var(--color-background-secondary)",
              transition:"all 0.15s"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              <i className="ti ti-upload" style={{fontSize:14,color:"#1656d6"}}/>
              <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>
                {loading?"⏳ Carregando…":"Inversores .xlsx"}
              </span>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple
              style={{display:"none"}} onChange={e=>addFiles(e.target.files)}/>
          </div>
          {errors.length>0&&(
            <div style={{margin:"0 8px 5px",padding:"5px 8px",borderRadius:5,fontSize:13,
              background:"var(--color-background-danger)",color:"var(--color-text-danger)",lineHeight:1.5}}>
              {errors.map((e,i)=><div key={i}>⚠ {e}</div>)}
            </div>
          )}
        </div>
      </aside>

            {/* Divisor lateral */}
      <div onMouseDown={onSideDrag}
        style={{width:5,cursor:"col-resize",flexShrink:0,background:"transparent",
          borderRight:"1px solid var(--color-border-tertiary)",
          display:"flex",alignItems:"center",justifyContent:"center"}}
        onMouseEnter={e=>e.currentTarget.style.background="rgba(46,155,255,0.18)"}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        <div style={{width:2,height:40,borderRadius:2,background:"rgba(148,163,184,0.22)",pointerEvents:"none"}}></div>
      </div>
      </>)}

      {/* ── Área principal ── */}
      <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0,minHeight:0}}>

        {/* ── Barra de navegação + abas ── */}
        {/* Só existe nas abas com upload de .xlsx (Variáveis/Desbalanceamento)
            — nas outras (Disponibilidade/Geração/Combiners) essa faixa não
            tinha mais nada além do botão de Atualizar, que agora mora na
            barra azul do dashboard principal; sem isso, ela virava uma tira
            branca vazia ocupando espaço à toa. */}
        {showFileTab && (
        <div style={{borderBottom:"1px solid rgba(24,36,73,0.10)",
          background:"#ffffff",flexShrink:0}}>

          {/* Linha 1: navegação + abas */}
          <div style={{display:"flex",alignItems:"center",padding:"0 14px",
            borderBottom:"0.5px solid var(--color-border-tertiary)",minHeight:38}}>

            {/* Setas de dia (só nas abas com upload de .xlsx) */}
            {showFileTab&&(
            <div style={{display:"flex",alignItems:"center",gap:2,marginRight:14,flexShrink:0}}>
              <button onClick={prevDate} disabled={curIdx<=0}
                style={{background:"none",border:"none",cursor:curIdx>0?"pointer":"default",fontSize:15,
                  color:curIdx>0?"var(--color-text-secondary)":"var(--color-text-tertiary)",
                  padding:"3px 5px",borderRadius:4,lineHeight:1,transition:"background 0.1s"}}
                onMouseEnter={e=>{if(curIdx>0)e.currentTarget.style.background="var(--color-background-secondary)";}}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <i className="ti ti-chevron-left"/>
              </button>
              <div style={{minWidth:118,textAlign:"center",padding:"3px 8px",borderRadius:5,
                background:"var(--color-background-secondary)",fontSize:13,fontWeight:600,
                color:selectedDate?"var(--color-text-primary)":"var(--color-text-tertiary)"}}>
                {selectedDate?(()=>{
                  const[y,m,d]=selectedDate.split("-");
                  return`${d}/${m}/${y}`;
                })():"Selecione um dia"}
              </div>
              <button onClick={nextDate} disabled={curIdx>=sortedDates.length-1}
                style={{background:"none",border:"none",cursor:curIdx<sortedDates.length-1?"pointer":"default",fontSize:15,
                  color:curIdx<sortedDates.length-1?"var(--color-text-secondary)":"var(--color-text-tertiary)",
                  padding:"3px 5px",borderRadius:4,lineHeight:1,transition:"background 0.1s"}}
                onMouseEnter={e=>{if(curIdx<sortedDates.length-1)e.currentTarget.style.background="var(--color-background-secondary)";}}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <i className="ti ti-chevron-right"/>
              </button>
              {sortedDates.length>0&&(
                <span style={{fontSize:13,color:"var(--color-text-tertiary)",marginLeft:3}}>
                  {curIdx>=0?curIdx+1:0}/{sortedDates.length}
                </span>
              )}
            </div>
            )}

            <div style={{marginLeft:"auto",fontSize:13,color:"var(--color-text-tertiary)",flexShrink:0,display:"flex",alignItems:"center",gap:10}}>
              <span>{visible.length} visível(is)</span>
              {selectedTime&&(
                <span style={{color:"#1656d6",display:"inline-flex",alignItems:"center",gap:4}}>
                  <i className="ti ti-map-pin" style={{fontSize:13}}/><strong>{selectedTime}</strong>
                  <button onClick={()=>setSelectedTime(null)}
                    style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#1656d6",padding:0,lineHeight:1,marginLeft:1}}>
                    <i className="ti ti-x"/>
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* Linha 2: seletores de variável (só na aba vars) */}
          {activeTab==="vars"&&(
            <div style={{padding:"6px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              {[0,1,2,3].map(vi=>(
                <VarSelect key={vi} id={`var${vi+1}sel`} value={vars[vi]}
                  onChange={key=>setVar(vi,key)} label={`V${vi+1}:`}
                  swatchColor={selectorColors[vi]} dashPattern={DASH_PATTERNS[vi]} optional={vi>0}/>
              ))}
              {dualAxis&&<span style={{fontSize:13,padding:"3px 8px",borderRadius:10,
                background:"rgba(46,155,255,0.1)",color:"#1B6FC9",flexShrink:0}}>eixo duplo</span>}
            </div>
          )}
        </div>
        )}

        {/* ── Área do gráfico / disponibilidade ── */}
        <div style={{flex:1,margin:"12px 14px 8px",
          padding:!showFileTab?"0":"14px 16px 8px",minHeight:0,overflow:"hidden",
          display:"flex",flexDirection:"column",
          background:"#ffffff",borderRadius:14,border:`1px solid ${P.chromeBorder}`,
          boxShadow:"0 8px 24px -16px rgba(20,30,60,0.25)"}}>
          {activeTab==="combiners"?(
            <CombinerPanel onLastUpdated={setLastUpdated} refreshTick={refreshTick} autoSyncTick={autoSyncTick}/>
          ):activeTab==="avail"?(
            <AvailabilityPanel onLastUpdated={setLastUpdated} refreshTick={refreshTick} autoSyncTick={autoSyncTick}/>
          ):activeTab==="gen"?(
            <GenerationPanel onLastUpdated={setLastUpdated} refreshTick={refreshTick} autoSyncTick={autoSyncTick}/>
          ):!selectedDate||inverters.length===0?(
            <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
              color:"var(--color-text-tertiary)",gap:14,textAlign:"center"}}>
              <i className="ti ti-chart-line" style={{fontSize:56}}/>
              <div style={{fontSize:15,fontWeight:500}}>
                {!hasData?"Carregue um arquivo .xlsx":"Selecione um dia no calendário"}
              </div>
              <div style={{fontSize:13,maxWidth:380,lineHeight:1.9,color:"var(--color-text-tertiary)"}}>
                {!hasData?<>Arraste um <strong>.xlsx</strong> na sidebar.<br/>Cada planilha dentro = um dia diferente.<br/>Vários arquivos = vários inversores.</>
                  :<>Use as setas ← → ou clique no calendário.<br/>Todos os inversores com dados naquele dia são sobrepostos.</>}
              </div>
            </div>
          ):activeTab==="vars"?(
            <InverterChart inverters={inverters} varKeys={vars} onPointClick={setSelectedTime}/>
          ):(
            <ImbalanceChart inverters={inverters} onPointClick={setSelectedTime}/>
          )}
        </div>

        {/* ── Divisor horizontal ── */}
        {showBottomPanel&&showStats&&(
          <div onMouseDown={onStatsDrag}
            style={{height:5,cursor:"row-resize",flexShrink:0,background:"transparent",
              borderTop:"1px solid var(--color-border-tertiary)",
              display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(46,155,255,0.18)"}
            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
            <div style={{height:2,width:40,borderRadius:2,background:"rgba(148,163,184,0.22)",pointerEvents:"none"}}></div>
          </div>
        )}

        {/* ── Painel inferior (oculto na aba disponibilidade) ── */}
        {showBottomPanel&&(
          <div style={{height:showStats?statsH:"auto",minHeight:showStats?80:"auto",
            borderTop:showStats?"none":"0.5px solid var(--color-border-tertiary)",
            display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden"}}>

            <div style={{padding:"5px 14px 0",display:"flex",alignItems:"center",justifyContent:"space-between",
              borderBottom:"0.5px solid var(--color-border-tertiary)",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:13,fontWeight:600,color:"var(--color-text-secondary)"}}>Análise</span>
                {inverters.some(i=>!i.visible)&&(
                  <span style={{fontSize:13,padding:"1px 6px",borderRadius:10,
                    background:"rgba(148,163,184,0.10)",color:"var(--color-text-tertiary)"}}>
                    {inverters.filter(i=>!i.visible).length} oculto(s) — dados mantidos
                  </span>
                )}
              </div>
              <button onClick={()=>setShowStats(s=>!s)}
                style={{background:"rgba(24,36,73,0.10)",border:"1px solid rgba(24,36,73,0.12)",cursor:"pointer",
                  width:22,height:22,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",
                  color:"var(--color-text-secondary)",fontSize:13,lineHeight:1,flexShrink:0}}>
                <i className={`ti ti-chevron-${showStats?"down":"up"}`}/>
              </button>
            </div>

            {showStats&&(
              <div style={{flex:1,display:"flex",gap:10,padding:"10px 14px 12px",overflow:"hidden",minHeight:0}}>

                {/* Col 1 – Estatísticas */}
                <div style={{flex:"0 0 38%",minWidth:220,
                  display:"flex",flexDirection:"column",overflow:"hidden",
                  background:"#eef1f8",borderRadius:12,border:"1px solid rgba(24,36,73,0.10)"}}>
                  <div style={{padding:"8px 13px 4px",fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",
                    textTransform:"uppercase",letterSpacing:"0.05em",flexShrink:0}}>
                    Estatísticas — {activeVars.map(k=>VAR_MAP[k]?.label).join(" · ")}
                  </div>
                  <StatsTable stats={stats} activeVars={activeVars} fmt={fmt}/>
                </div>

                {/* Col 2 – Snapshot */}
                <div style={{flex:"0 0 27%",minWidth:160,
                  display:"flex",flexDirection:"column",overflow:"hidden",
                  background:"#eef1f8",borderRadius:12,border:"1px solid rgba(24,36,73,0.10)"}}>
                  <div style={{padding:"8px 13px 4px",fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",
                    textTransform:"uppercase",letterSpacing:"0.05em",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
                    <i className="ti ti-map-pin" style={{fontSize:13,color:"#1656d6"}}/>
                    Ponto {selectedTime&&<span style={{color:"#1656d6",fontWeight:700,marginLeft:3}}>{selectedTime}</span>}
                  </div>
                  {!selectedTime?(
                    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                      color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center",padding:12}}>
                      <i className="ti ti-hand-click" style={{fontSize:24,marginBottom:5}}/>
                      Clique no gráfico para inspecionar
                    </div>
                  ):(
                    <SnapshotTable snapshot={snapshot} activeVars={activeVars}/>
                  )}
                </div>

                {/* Col 3 – Desbalanceamento */}
                <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",overflow:"hidden",
                  background:"#eef1f8",borderRadius:12,border:"1px solid rgba(24,36,73,0.10)"}}>
                  <div style={{padding:"8px 13px 3px",fontSize:13,fontWeight:600,color:"var(--color-text-tertiary)",
                    textTransform:"uppercase",letterSpacing:"0.05em",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
                    <i className="ti ti-arrows-left-right" style={{fontSize:13,color:"#1656d6"}}/>Desbalanceamento pvbus/nvbus
                  </div>
                  {imbalanceData.every(d=>d.min===null)?(
                    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
                      color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center",padding:10}}>
                      <div><i className="ti ti-alert-circle" style={{fontSize:20,display:"block",marginBottom:4}}/>Sem pvbus/nvbus</div>
                    </div>
                  ):(
                    <ImbalanceTable imbalanceData={imbalanceData} selectedTime={selectedTime} alertC={alertC} fmtPct={fmtPct}/>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
    </div>
  );
});

// ── Tabela de Estatísticas (sortable) ────────────────────────────────────────
function StatsTable({ stats, activeVars, fmt }) {
  const { sortKey, sortDir, toggle } = useSortableTable("name","asc");
  const flat = useMemo(() => {
    const rows = stats.flatMap(s =>
      s.varStats.map((vs, vi) => ({
        name: s.displayName||s.name,
        varLabel: VAR_MAP[vs.key]?.label??vs.key,
        min: vs.min, max: vs.max, avg: vs.avg,
        s, vs, vi, isHid: !s.visible,
      }))
    );
    return applySortDir(rows, sortKey, sortDir);
  }, [stats, sortKey, sortDir, activeVars.join(",")]);

  return (
    <div style={{overflowY:"auto",overflowX:"hidden",flex:1,padding:"0 12px 8px"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead style={{position:"sticky",top:0,zIndex:1,background:"#eef1f8"}}>
          <tr>
            <SortTh label="Inversor" sortKey={sortKey} col="name"     sortDir={sortDir} onSort={toggle} align="left"/>
            <SortTh label="Variável" sortKey={sortKey} col="varLabel" sortDir={sortDir} onSort={toggle} align="left"/>
            <SortTh label="Mín"      sortKey={sortKey} col="min"      sortDir={sortDir} onSort={toggle}/>
            <SortTh label="Máx"      sortKey={sortKey} col="max"      sortDir={sortDir} onSort={toggle}/>
            <SortTh label="Média"    sortKey={sortKey} col="avg"      sortDir={sortDir} onSort={toggle}/>
          </tr>
        </thead>
        <tbody>
          {flat.map((row, idx) => {
            const { s, vs, vi, isHid } = row;
            const info=VAR_MAP[vs.key], color=varColor(s.paletteIdx,vi), dash=DASH_PATTERNS[vi];
            return (
              <tr key={`${s.id}-${vs.key}-${idx}`}
                style={{background:idx%2===1?"var(--color-background-secondary)":"transparent",opacity:isHid?0.45:1}}>
                <td style={{padding:"3px 6px",whiteSpace:"nowrap"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:s.color,flexShrink:0,
                      outline:isHid?`2px dashed ${s.color}`:`2px solid ${s.color}44`,outlineOffset:1}}></span>
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:110,
                      fontSize:11,fontWeight:500,color:isHid?"var(--color-text-tertiary)":"var(--color-text-primary)"}}
                      title={s.displayName||s.name}>
                      {s.displayName||s.name}
                      {isHid&&<span style={{fontSize:11,marginLeft:3,color:"var(--color-text-tertiary)"}}>(oculto)</span>}
                    </span>
                  </div>
                </td>
                <td style={{padding:"3px 6px",whiteSpace:"nowrap"}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <svg width="16" height="8" style={{flexShrink:0}}>
                      <line x1="0" y1="4" x2="16" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray={dash.join(",")}/>
                    </svg>
                    <span style={{fontSize:11,color,whiteSpace:"nowrap"}}>{info?.label??vs.key}</span>
                  </div>
                </td>
                {[vs.min,vs.max,vs.avg].map((v,j)=>(
                  <td key={j} style={{padding:"3px 6px",textAlign:"right",fontFamily:"var(--font-mono)",
                    fontSize:11,color:isHid?"var(--color-text-tertiary)":"var(--color-text-primary)",whiteSpace:"nowrap"}}>
                    {fmt(v)}{v!==null&&<span style={{color:"var(--color-text-tertiary)",marginLeft:2,fontSize:10}}>{info?.unit}</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Tabela de Snapshot (sortable) ────────────────────────────────────────────
function SnapshotTable({ snapshot, activeVars }) {
  const { sortKey, sortDir, toggle } = useSortableTable("name","asc");
  const rows = useMemo(() => {
    if (!snapshot) return [];
    const base = snapshot.map(s => {
      const obj = { name: s.displayName||s.name, s };
      activeVars.forEach((k,vi) => { obj[k] = s.values[vi]?.value ?? null; });
      return obj;
    });
    return applySortDir(base, sortKey, sortDir);
  }, [snapshot, sortKey, sortDir, activeVars.join(",")]);

  return (
    <div style={{overflowY:"auto",overflowX:"hidden",flex:1,padding:"0 12px 8px"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead style={{position:"sticky",top:0,zIndex:1,background:"#eef1f8"}}>
          <tr>
            <SortTh label="Inversor" sortKey={sortKey} col="name" sortDir={sortDir} onSort={toggle} align="left"/>
            {activeVars.map((k)=>(
              <SortTh key={k} label={VAR_MAP[k]?.label??k} sortKey={sortKey} col={k} sortDir={sortDir} onSort={toggle}/>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row,si)=>{
            const s=row.s;
            return (
              <tr key={s.id} style={{background:si%2===1?"var(--color-background-secondary)":"transparent",opacity:s.visible?1:0.45}}>
                <td style={{padding:"3px 6px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:s.color,flexShrink:0}}></span>
                    <span style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:90,
                      color:s.visible?"var(--color-text-primary)":"var(--color-text-tertiary)"}}
                      title={s.displayName||s.name}>{s.displayName||s.name}</span>
                  </div>
                </td>
                {activeVars.map((k,vi)=>{
                  const v=s.values[vi]?.value;
                  return (
                    <td key={k} style={{padding:"3px 6px",textAlign:"right",fontFamily:"var(--font-mono)",
                      fontSize:11,whiteSpace:"nowrap",
                      color:v!==null&&v!==undefined?varColor(s.paletteIdx,vi):"var(--color-text-tertiary)"}}>
                      {v!==null&&v!==undefined?<>{v.toFixed(3)}<span style={{color:"var(--color-text-tertiary)",marginLeft:3,fontSize:11}}>{VAR_MAP[k]?.unit}</span></>:"—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Tabela de Desbalanceamento (sortable) ────────────────────────────────────
function ImbalanceTable({ imbalanceData, selectedTime, alertC, fmtPct }) {
  const { sortKey, sortDir, toggle } = useSortableTable("name","asc");
  const rows = useMemo(() => {
    const base = imbalanceData.map(d => ({
      name: d.displayName||d.name, atPoint: d.atPoint,
      min: d.min, max: d.max, avg: d.avg, d,
    }));
    return applySortDir(base, sortKey, sortDir);
  }, [imbalanceData, sortKey, sortDir]);

  return (
    <div style={{overflowY:"auto",overflowX:"hidden",flex:1,padding:"0 12px 8px"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead style={{position:"sticky",top:0,zIndex:1,background:"#eef1f8"}}>
          <tr>
            <SortTh label="Inversor" sortKey={sortKey} col="name"    sortDir={sortDir} onSort={toggle} align="left"/>
            <SortTh label={selectedTime?`Às ${selectedTime}`:"—"} sortKey={sortKey} col="atPoint" sortDir={sortDir} onSort={toggle}/>
            <SortTh label="Mín"      sortKey={sortKey} col="min"     sortDir={sortDir} onSort={toggle}/>
            <SortTh label="Máx"      sortKey={sortKey} col="max"     sortDir={sortDir} onSort={toggle}/>
            <SortTh label="Média"    sortKey={sortKey} col="avg"     sortDir={sortDir} onSort={toggle}/>
          </tr>
        </thead>
        <tbody>
          {rows.map((row,i)=>{
            const d=row.d;
            return (
              <tr key={d.id} style={{background:i%2===1?"var(--color-background-secondary)":"transparent",opacity:d.visible?1:0.45}}>
                <td style={{padding:"3px 6px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:d.color,flexShrink:0}}></span>
                    <span style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:80,
                      color:d.visible?"var(--color-text-primary)":"var(--color-text-tertiary)"}}
                      title={d.displayName||d.name}>{d.displayName||d.name}</span>
                  </div>
                </td>
                <td style={{padding:"3px 6px",textAlign:"right",fontFamily:"var(--font-mono)",fontSize:11,
                  fontWeight:600,color:selectedTime?alertC(d.atPoint):"var(--color-text-tertiary)",whiteSpace:"nowrap"}}>
                  {selectedTime?fmtPct(d.atPoint):"—"}
                </td>
                {[d.min,d.max,d.avg].map((v,j)=>(
                  <td key={j} style={{padding:"3px 6px",textAlign:"right",fontFamily:"var(--font-mono)",
                    fontSize:11,color:alertC(v),whiteSpace:"nowrap"}}>{fmtPct(v)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{marginTop:5,display:"flex",gap:12,flexWrap:"wrap",fontSize:11,
        color:"var(--color-text-tertiary)",paddingLeft:2}}>
        <span><span style={{color:"#4CAF50"}}>●</span> &lt;35% normal</span>
        <span><span style={{color:"#FF9800"}}>●</span> 35–70% atenção</span>
        <span><span style={{color:"#F44336"}}>●</span> &gt;70% crítico</span>
      </div>
    </div>
  );
}

// Curva de potência (Pac, kW) ao longo do dia, uma linha por inversor — mesmo formato do
// gráfico de Combiners, só que por inversor em vez de por canal, pra achar em que horário
// a geração cai.
function GenerationCurveChart({ entries, pacMap, viewKey }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const viewKeyRef = useRef(null); // identifica a "visão" atual (grupo+dia) — muda de verdade só quando o usuário navega
  const [ready, setReady] = useState(!!window._chartReady);
  useEffect(()=>{ if(window._chartReady){registerSmartTooltip();setReady(true);return;} loadChartLibs().then(()=>setReady(true)); },[]);

  useEffect(()=>{
    if(!ready||!canvasRef.current) return;
    if(!entries.length||!pacMap) {
      if(chartRef.current){chartRef.current.destroy();chartRef.current=null;viewKeyRef.current=null;}
      return;
    }

    const timeSet = new Set();
    entries.forEach(e=>(pacMap[e.invKey]||[]).forEach(s=>timeSet.add(s.time)));
    const labels = [...timeSet].sort();
    if(!labels.length) return;

    const datasets = entries.map(e=>{
      const bySample = new Map((pacMap[e.invKey]||[]).map(s=>[s.time,s.pac]));
      return {
        label: e.name,
        data: labels.map(t=>{ const v=bySample.get(t); return (v!=null&&isFinite(v))?v:null; }),
        borderColor: e.color, backgroundColor:"transparent",
        borderWidth:1.5, pointRadius:0, pointHoverRadius:4, tension:0.35, spanGaps:false,
      };
    });

    // Mesma visão (grupo+dia) de antes — só atualiza os dados, preservando zoom/pan
    // aplicado pelo usuário (destruir e recriar o Chart.js reseta o zoom).
    if (chartRef.current && viewKeyRef.current===viewKey) {
      chartRef.current.data.labels = labels;
      chartRef.current.data.datasets = datasets;
      chartRef.current.update("none");
      return;
    }

    if (chartRef.current) chartRef.current.destroy();
    viewKeyRef.current = viewKey;
    chartRef.current = new window.Chart(canvasRef.current,{
      type:"line", data:{labels,datasets},
      options:{
        responsive:true, maintainAspectRatio:false, animation:false,
        interaction:{mode:"index",intersect:false},
        plugins:{
          legend:{display:true,position:"bottom",labels:{color:"#8595A6",boxWidth:10,font:{size:10}}},
          tooltip:{position:"smart",backgroundColor:"rgba(38,50,68,0.97)",titleColor:"#A7B6C6",bodyColor:"#EAF2FB",
            borderColor:"rgba(46,155,255,0.40)",borderWidth:1,padding:10,
            callbacks:{title:items=>items[0]?.label??"",
              label:ctx=>`  ${ctx.dataset.label}: ${ctx.parsed.y!=null?ctx.parsed.y.toFixed(1)+" kW":"—"}`,
              labelTextColor:ctx=>ctx.dataset.borderColor}},
          zoom:{pan:{enabled:true,mode:"xy",threshold:10},
            zoom:{wheel:{enabled:true,mode:"xy"},pinch:{enabled:false},drag:{enabled:false},mode:"xy"}},
        },
        scales:{
          x: timeAxisScale(),
          y:{position:"left",ticks:{color:"#8595A6",font:{size:11},maxTicksLimit:8,callback:v=>v.toFixed(0)+" kW"},
            grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
            title:{display:true,text:"Potência (kW)",color:"#A7B6C6",font:{size:11}}},
        },
      },
    });
  },[ready,entries,pacMap,viewKey]);

  useEffect(()=>()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}},[]);

  return(
    <div style={{position:"relative",width:"100%",height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{flex:1,minHeight:0,position:"relative"}}>
        {(!ready||!entries.length||!pacMap)&&(
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
            color:"var(--color-text-tertiary)",fontSize:13}}>
            {!ready?"Carregando…":"Sem dados"}
          </div>
        )}
        <canvas ref={canvasRef} role="img" style={{cursor:"crosshair"}} onDoubleClick={()=>chartRef.current?.resetZoom()}/>
      </div>
    </div>
  );
}

// ── Painel de Geração ─────────────────────────────────────────────────────────
const GEN_PERIOD_LABELS = { daily:"Diário", weekly:"7 dias", monthly:"Mensal" };

function GenerationPanel({ onLastUpdated, refreshTick, autoSyncTick }) {
  const invMap = useInverterMap(refreshTick, autoSyncTick);
  const dates = useMemo(()=>last30Dates(),[]);
  const today = dates[dates.length-1];
  const [period, setPeriod] = useState("daily");
  const [unit, setUnit]     = useState("MWh");
  const [chartType, setChartType] = useState("line"); // "line" (curva) ou "bar" (colunas)
  const [selDate, setSelDate] = useState(today);
  const [rows, setRows] = useState(()=>_genRowsCache || []); // [{sn,date,eInjection,eAbsorption}] — seedado do cache de módulo, se já existir
  const [loading, setLoading] = useState(!_genRowsCache);
  const [fatalError, setFatalError] = useState(null);
  const uF  = unit==="kWh" ? 1000 : 1;                 // fator de conversão (gen é calculada em MWh)
  const uDec = unit==="kWh" ? 0 : 3;                   // casas decimais p/ total/média
  const uDecR = unit==="kWh" ? 0 : 1;                  // casas decimais p/ rankings
  const fmtU = (mwh,dec)=> (mwh*uF).toLocaleString("pt-BR",{minimumFractionDigits:dec,maximumFractionDigits:dec});
  const [chartReady, setChartReady] = useState(!!window._chartReady);
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(()=>{ if(window._chartReady){setChartReady(true);return;} loadChartLibs().then(()=>setChartReady(true)); },[]);

  // Só busca do zero se ainda não há nada no cache de módulo (primeiro carregamento da
  // sessão) — trocar de aba e voltar reaproveita o que já foi buscado, sem recarregar.
  useEffect(()=>{
    if (_genRowsCache) return;
    let cancelled = false;
    (async()=>{
      setLoading(true);
      try {
        const res = await fetch(`/api/generation?from=${dates[0]}&to=${dates[dates.length-1]}`);
        if (!res.ok) {
          const body = await res.json().catch(()=>({}));
          throw new Error(body.error || `Erro ${res.status}`);
        }
        const data = await res.json();
        _genRowsCache = data;
        if (!cancelled) { setRows(data); onLastUpdated?.(new Date()); }
      } catch(err) {
        if (!cancelled) setFatalError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return ()=>{ cancelled=true; };
  },[dates, onLastUpdated]);

  // Botão "Atualizar" (refreshTick) força revalidar — nunca acontece sozinho, pra não
  // trocar dados debaixo de uma análise em andamento sem o usuário pedir.
  const lastGenTickRef = useRef(refreshTick);
  useEffect(()=>{
    if (refreshTick===lastGenTickRef.current) return;
    lastGenTickRef.current = refreshTick;
    (async()=>{
      try {
        const res = await fetch(`/api/generation?from=${dates[0]}&to=${dates[dates.length-1]}`);
        if (!res.ok) return;
        const data = await res.json();
        _genRowsCache = data;
        setRows(data);
        onLastUpdated?.(new Date());
      } catch { /* falha silenciosa — usuário pode tentar de novo */ }
    })();
  },[refreshTick, dates, onLastUpdated]);

  const dateIdx = dates.indexOf(selDate);
  const goPrevDay = () => { if(dateIdx>0) setSelDate(dates[dateIdx-1]); };
  const goNextDay = () => { if(dateIdx<dates.length-1) setSelDate(dates[dateIdx+1]); };

  // Agrega geração (EInjection, kWh→MWh) por inversor e período, a partir do cache já baixado
  const genData = useMemo(()=>{
    if(!rows.length) return [];
    let periodDates;
    if(period==="daily"){
      periodDates=new Set([selDate]);
    } else if(period==="weekly"){
      periodDates=new Set(dates.slice(Math.max(0,dateIdx-6),dateIdx+1));
    } else {
      const ym=selDate.slice(0,6);
      periodDates=new Set(dates.filter(d=>d.startsWith(ym)));
    }
    // Semeia com todo SN já visto (no cache de 30 dias) ou já mapeado (invMap), não só os
    // que têm dado no período: um inversor que ficou fora do ar no dia/semana/mês selecionado
    // não tem nenhuma linha ali e sumia inteiro do ranking em vez de aparecer com 0.
    const bySn={};
    rows.forEach(r=>{ bySn[r.sn] ??= []; });
    Object.keys(invMap).forEach(sn=>{ bySn[sn] ??= []; });
    rows.forEach(r=>{
      if(!periodDates.has(r.date.replaceAll("-",""))) return;
      bySn[r.sn].push(r);
    });
    const list = Object.entries(bySn)
      .map(([sn,recs])=>{
        const pos = invMap[sn]; // ex.: "3.4.1"
        return {
          invKey:sn, name:invName(sn,invMap),
          gen: recs.reduce((s,r)=>s+(r.eInjection||0),0)/1000, // kWh → MWh
          group: pos ? pos.slice(-1) : null, // "1" (17 combiners) ou "2" (16 combiners)
          pairKey: pos ? pos.slice(0,pos.lastIndexOf(".")) : null, // ex.: "3.4" — mesmo par entre 3.4.1 e 3.4.2
        };
      })
      .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    // Cor por par (3.x.1/3.x.2), não por posição na lista — assim o mesmo inversor "espelhado"
    // nos dois agrupamentos (17 e 16 combiners) fica com a mesma cor, fácil de comparar.
    const pairKeys = [...new Set(list.map(d=>d.pairKey ?? d.invKey))]
      .sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));
    const colorByPair = Object.fromEntries(pairKeys.map((k,i)=>[k, invColor(i)]));
    return list.map(d=>({...d, color: colorByPair[d.pairKey ?? d.invKey]}));
  },[rows,period,selDate,dateIdx,dates,invMap]);

  // Agrupa por posição: termina em 1 → inversor com 17 combiners; termina em 2 → 16 combiners
  const groups = useMemo(()=>{
    const g1=genData.filter(d=>d.group==="1").sort((a,b)=>b.gen-a.gen);
    const g2=genData.filter(d=>d.group==="2").sort((a,b)=>b.gen-a.gen);
    const other=genData.filter(d=>d.group!=="1"&&d.group!=="2").sort((a,b)=>b.gen-a.gen);
    return {g1,g2,other};
  },[genData]);

  // Δ% entre maior e menor geração de um grupo
  const spreadPct = arr => {
    if(arr.length<2) return null;
    const max=arr[0].gen, min=arr[arr.length-1].gen;
    return min>0 ? (max-min)/min*100 : null;
  };

  // Render bar chart via Chart.js (ranking por inversor) — usado quando chartType==="bar"
  // ou quando não há como montar a curva por horário (período diferente de diário)
  useEffect(()=>{
    if(!chartReady||!canvasRef.current||!genData.length) return;
    if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}
    // Ordem: grupo 1 (ranqueado) · espaço · grupo 2 (ranqueado) · outros
    const ordered=[];
    groups.g1.forEach(d=>ordered.push(d));
    if(groups.g1.length&&(groups.g2.length||groups.other.length)) ordered.push({spacer:true,name:"",color:"#00000000"});
    groups.g2.forEach(d=>ordered.push(d));
    if(groups.g2.length&&groups.other.length) ordered.push({spacer:true,name:" ",color:"#00000000"});
    groups.other.forEach(d=>ordered.push(d));
    const labels=ordered.map(d=>d.name);
    const values=ordered.map(d=>d.spacer?null:d.gen*uF);
    const colors=ordered.map(d=>d.color);
    chartRef.current=new window.Chart(canvasRef.current,{
      type:"bar",
      data:{
        labels,
        datasets:[{
          label:"Geração (MWh)",
          data:values,
          backgroundColor:colors.map(c=>c+"cc"),
          borderColor:colors,
          borderWidth:1.5,
          borderRadius:4,
        }]
      },
      options:{
        indexAxis:"y",  // barras horizontais — mais legível com muitos inversores
        responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor:"rgba(38,50,68,0.97)",titleColor:"#A7B6C6",bodyColor:"#EAF2FB",
            borderColor:"#e0e0e0",borderWidth:1,padding:10,
            callbacks:{
              label:ctx=>`  ${ctx.parsed.x.toLocaleString("pt-BR",{maximumFractionDigits:uDecR})} ${unit}`,
            }
          }
        },
        scales:{
          x:{
            ticks:{color:"#8595A6",font:{size:11}},
            grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
            title:{display:true,text:unit,color:"#A7B6C6",font:{size:11}},
          },
          y:{
            ticks:{color:"#8595A6",font:{size:11}},
            grid:{color:"rgba(0,0,0,0.04)"},border:{color:"rgba(0,0,0,0.12)"},
          },
        },
      },
    });
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}};
  },[chartReady,groups,unit,chartType,period]); // chartType/period: reconstrói ao voltar da curva por horário (canvas é remontado)

  // Curva por horário (Pac, kW) — só faz sentido no período Diário; busca sob demanda e cacheia
  // por data no módulo (_pacCache é compartilhado com o painel de Disponibilidade)
  const showCurve = chartType==="line" && period==="daily";
  const [pacByDate, setPacByDate] = useState(()=>({..._pacCache})); // { [date]: {[boardId]: [{time,pac}]} }
  const [pacLoading, setPacLoading] = useState(false);
  const [pacError, setPacError] = useState(null);

  useEffect(()=>{
    if(!showCurve || pacByDate[selDate]) return;
    let cancelled = false;
    (async()=>{
      setPacLoading(true); setPacError(null);
      try {
        const res = await fetch(`/api/availability?date=${selDate}`);
        if (!res.ok) {
          const body = await res.json().catch(()=>({}));
          throw new Error(body.error || `Erro ${res.status}`);
        }
        const data = await res.json();
        _pacCache = { ..._pacCache, [selDate]: data };
        if (!cancelled) setPacByDate(prev=>({...prev,[selDate]:data}));
      } catch(err) {
        if (!cancelled) setPacError(err.message);
      } finally {
        if (!cancelled) setPacLoading(false);
      }
    })();
    return ()=>{ cancelled=true; };
  },[showCurve, selDate, pacByDate]);

  // Botão "Atualizar" também revalida a curva do dia selecionado
  const lastPacTickRef = useRef(refreshTick);
  useEffect(()=>{
    if (refreshTick===lastPacTickRef.current) return;
    lastPacTickRef.current = refreshTick;
    if (selDate===today) delete _pacCache[selDate];
    setPacByDate(prev=>{ if(!(selDate in prev)) return prev; const {[selDate]:_,...rest}=prev; return rest; });
  },[refreshTick, selDate, today]);

  // Auto-sync (a cada ~15min, roda sempre em segundo plano — ver useAutoSync no App):
  // só relê os caches já atualizados por runAutoSync, sem novo fetch e sem tocar em seleção/zoom.
  const lastGenAutoTickRef = useRef(autoSyncTick);
  useEffect(()=>{
    if (autoSyncTick===lastGenAutoTickRef.current) return;
    lastGenAutoTickRef.current = autoSyncTick;
    if (_genRowsCache) { setRows(_genRowsCache); onLastUpdated?.(new Date()); }
    if (_pacCache[today]) setPacByDate(prev=>({...prev,[today]:_pacCache[today]}));
  },[autoSyncTick, today, onLastUpdated]);

  const total   = genData.reduce((s,d)=>s+d.gen,0);
  const avg     = genData.length>0 ? total/genData.length : 0;

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",padding:"10px 16px 8px",minHeight:0}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexShrink:0,flexWrap:"wrap"}}>
        {/* Toggle período */}
        <div style={{display:"flex",gap:2,background:"var(--color-background-secondary)",padding:3,borderRadius:8,flexShrink:0}}>
          {["daily","weekly","monthly"].map(p=>(
            <button key={p}
              onClick={()=>setPeriod(p)}
              onDoubleClick={()=>{
                setPeriod(p);
                if(p==="daily"||p==="weekly") setSelDate(today);
              }}
              title={p==="daily"?"Clique: período diário · 2× clique: ir ao dia mais recente"
                    :p==="weekly"?"Clique: 7 dias · 2× clique: 7 dias até o mais recente"
                    :GEN_PERIOD_LABELS[p]}
              style={{padding:"5px 14px",fontSize:13,cursor:"pointer",borderRadius:6,border:"none",
                background:period===p?"#1656d6":"transparent",
                color:period===p?"#fff":"var(--color-text-secondary)",
                fontWeight:period===p?600:400,transition:"all 0.15s"}}>
              {GEN_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        {/* Toggle unidade */}
        <div style={{display:"flex",gap:2,background:"var(--color-background-secondary)",padding:3,borderRadius:8,flexShrink:0}}>
          {["MWh","kWh"].map(u=>(
            <button key={u} onClick={()=>setUnit(u)}
              title={`Exibir geração em ${u}`}
              style={{padding:"5px 12px",fontSize:13,cursor:"pointer",borderRadius:6,border:"none",
                background:unit===u?"#1656d6":"transparent",
                color:unit===u?"#fff":"var(--color-text-secondary)",
                fontWeight:unit===u?600:400,transition:"all 0.15s"}}>
              {u}
            </button>
          ))}
        </div>
        {/* Toggle tipo de gráfico */}
        <div style={{display:"flex",gap:2,background:"var(--color-background-secondary)",padding:3,borderRadius:8,flexShrink:0}}>
          {[{k:"bar",label:"Colunas",icon:"ti-chart-bar"},{k:"line",label:"Linha",icon:"ti-chart-line"}].map(({k,label,icon})=>{
            const disabled = k==="line" && period!=="daily";
            return(
              <button key={k} disabled={disabled} onClick={()=>!disabled&&setChartType(k)}
                title={disabled?"Curva por horário disponível só no período Diário"
                      :k==="line"?"Curva de potência (kW) ao longo do dia — mostra em que horário a geração cai"
                      :"Gráfico em colunas (ranking por inversor)"}
                style={{padding:"5px 12px",fontSize:13,borderRadius:6,border:"none",display:"flex",alignItems:"center",gap:5,
                  cursor:disabled?"default":"pointer",opacity:disabled?0.4:1,
                  background:chartType===k?"#1656d6":"transparent",
                  color:chartType===k?"#fff":"var(--color-text-secondary)",
                  fontWeight:chartType===k?600:400,transition:"all 0.15s"}}>
                <i className={`ti ${icon}`}/>{label}
              </button>
            );
          })}
        </div>
        {(period==="daily"||period==="weekly")&&(
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={goPrevDay} disabled={dateIdx<=0}
              style={{background:"none",border:"none",cursor:dateIdx>0?"pointer":"default",fontSize:15,
                color:dateIdx>0?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-left"/>
            </button>
            <span style={{fontSize:13,fontWeight:600,minWidth:88,textAlign:"center",fontFamily:"var(--font-mono)"}}>
              {fmtYmd(selDate)}
            </span>
            <button onClick={goNextDay} disabled={dateIdx>=dates.length-1}
              style={{background:"none",border:"none",cursor:dateIdx<dates.length-1?"pointer":"default",fontSize:15,
                color:dateIdx<dates.length-1?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
              <i className="ti ti-chevron-right"/>
            </button>
          </div>
        )}
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>
          <strong>{genData.length}</strong> inversores
          · Total: <strong style={{color:"#1656d6"}}>{fmtU(total||0,uDec)} {unit}</strong>
          · Média: <strong>{fmtU(avg||0,uDec)} {unit}</strong>
        </div>
      </div>

      {/* Corpo: gráfico + rankings */}
      <div style={{flex:1,display:"flex",gap:0,overflow:"hidden",minHeight:0}}>

        {/* ── Gráfico: colunas (ranking) ou curva por horário ── */}
        <div style={{flex:1,minWidth:0,paddingRight:12,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{flex:1,minHeight:0,position:"relative"}}>
            {fatalError?(
              <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center"}}>
                <div><i className="ti ti-plug-connected-x" style={{fontSize:40,display:"block",marginBottom:8}}/>{fatalError}</div>
              </div>
            ):showCurve?(
              pacError?(
                <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  color:"var(--color-text-tertiary)",fontSize:13,textAlign:"center"}}>
                  <div><i className="ti ti-plug-connected-x" style={{fontSize:40,display:"block",marginBottom:8}}/>{pacError}</div>
                </div>
              ):!chartReady||pacLoading||!genData.length?(
                <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  color:"var(--color-text-tertiary)",fontSize:13}}>
                  {pacLoading?"Carregando…":!genData.length?"Sem dados para o período":"Carregando…"}
                </div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:8,height:"100%",minHeight:0}}>
                  {groups.g1.length>0&&(
                    <div style={{flex:1,minHeight:0}}>
                      <GenerationCurveChart entries={groups.g1} pacMap={pacByDate[selDate]} viewKey={`g1|${selDate}`}/>
                    </div>
                  )}
                  {groups.g2.length>0&&(
                    <div style={{flex:1,minHeight:0}}>
                      <GenerationCurveChart entries={groups.g2} pacMap={pacByDate[selDate]} viewKey={`g2|${selDate}`}/>
                    </div>
                  )}
                </div>
              )
            ):!chartReady||loading||!genData.length?(
              <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                color:"var(--color-text-tertiary)",fontSize:13}}>
                {loading?"Carregando…":!genData.length?"Sem dados para o período":"Carregando…"}
              </div>
            ):(
              <canvas ref={canvasRef} role="img"/>
            )}
          </div>
        </div>

        {/* ── Rankings por terminação (Final 1 / Final 2) ── */}
        <div style={{width:190,flexShrink:0,display:"flex",flexDirection:"column",gap:6,
          paddingLeft:10,borderLeft:"0.5px solid var(--color-border-tertiary)",overflowY:"auto"}}>

          {[{key:"g1",arr:groups.g1},{key:"g2",arr:groups.g2}].map(({key,arr})=>{
            if(!arr.length) return null;
            const gmax=arr[0]?.gen||0;
            const gavg=arr.reduce((s,x)=>s+x.gen,0)/arr.length;
            return(
              <div key={key} style={{flexShrink:0}}>
                <div style={{display:"flex",justifyContent:"flex-end",marginBottom:3}}>
                  <span title="Média de geração do grupo"
                    style={{fontSize:11,fontFamily:"var(--font-mono)",fontWeight:700,
                      color:"#A7B6C6",background:"var(--color-background-secondary)",
                      padding:"1px 6px",borderRadius:5,flexShrink:0}}>
                    {fmtU(gavg,uDecR)} {unit}
                  </span>
                </div>
                {arr.map((d,i)=>{
                  const pct=gmax>0?d.gen/gmax*100:0;
                  const dp=gavg>0?(d.gen-gavg)/gavg*100:0;
                  const dpColor=dp>=0?"#4CAF50":"#F44336";
                  return(
                    <div key={d.invKey} style={{position:"relative",display:"flex",alignItems:"center",gap:4,
                      padding:"2px 6px",marginBottom:1,borderRadius:5,overflow:"hidden",
                      background:"var(--color-background-secondary)"}}>
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,
                        background:d.color,opacity:0.18}}></div>
                      <span style={{position:"relative",fontSize:11,color:"var(--color-text-tertiary)",fontWeight:700,
                        minWidth:12,textAlign:"center"}}>#{i+1}</span>
                      <span style={{position:"relative",width:7,height:7,borderRadius:"50%",background:d.color,flexShrink:0}}></span>
                      <span style={{position:"relative",fontSize:11,fontWeight:600,flex:1,overflow:"hidden",
                        textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--color-text-primary)"}}
                        title={d.name}>{d.name}</span>
                      <span style={{position:"relative",fontSize:11,fontFamily:"var(--font-mono)",fontWeight:700,
                          color:dpColor,minWidth:42,textAlign:"right",flexShrink:0}}
                        title={`${fmtU(d.gen??0,uDecR)} ${unit}`}>
                        {dp>=0?"+":""}{dp.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {groups.other.length>0&&(
            <div style={{flexShrink:0}}>
              {groups.other.map((d,i)=>{
                const gmax=groups.other[0]?.gen||0;
                const pct=gmax>0?d.gen/gmax*100:0;
                return(
                  <div key={d.invKey} style={{position:"relative",display:"flex",alignItems:"center",gap:4,
                    padding:"2px 6px",marginBottom:1,borderRadius:5,overflow:"hidden",
                    background:"var(--color-background-secondary)"}}>
                    <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,
                      background:d.color,opacity:0.18}}></div>
                    <span style={{position:"relative",fontSize:11,color:"var(--color-text-tertiary)",fontWeight:700,
                      minWidth:12,textAlign:"center"}}>#{i+1}</span>
                    <span style={{position:"relative",width:7,height:7,borderRadius:"50%",background:d.color,flexShrink:0}}></span>
                    <span style={{position:"relative",fontSize:11,fontWeight:600,flex:1,overflow:"hidden",
                      textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--color-text-primary)"}}
                      title={d.name}>{d.name}</span>
                    <span style={{position:"relative",fontSize:11,fontFamily:"var(--font-mono)",fontWeight:700,
                      color:"#1656d6",flexShrink:0,whiteSpace:"nowrap"}}>{fmtU(d.gen??0,uDecR)}
                      <span style={{fontSize:10,color:"var(--color-text-tertiary)",marginLeft:2}}>{unit}</span></span>
                  </div>
                );
              })}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Combiners (API INGECON SUN Monitor — corrente DC por combiner) ───────────
const SB_CACHE_PREFIX  = "ingecon_sb_v2_"; // v2: GId de "group1/device2" (posição 4.4.2) agora vem canonicalizado da API
const SB_FETCH_SPACING_MS = 3500; // espaça chamadas p/ respeitar limite de 20 req distintas/min da API

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}
function last30Dates() {
  const arr = [];
  const now = new Date();
  for (let i=29; i>=0; i--) {
    const d = new Date(now); d.setDate(d.getDate()-i);
    arr.push(ymd(d));
  }
  return arr;
}
function fmtYmd(yyyymmdd) {
  if (!yyyymmdd) return "—";
  return `${yyyymmdd.slice(6,8)}/${yyyymmdd.slice(4,6)}/${yyyymmdd.slice(0,4)}`;
}

// Cada GId termina em ".1ST" ou ".2ST" — caixas de posição ímpar (1) têm 17 entradas
// reais conectadas, caixas de posição par (2) têm só 16.
function sbChannelCount(gid) {
  const m = String(gid).match(/\.(\d+)ST$/i);
  if (!m) return 17;
  return (parseInt(m[1],10) % 2 === 1) ? 17 : 16;
}

// Agrupa as leituras por GId (nunca por SN — SN é do concentrador e é igual p/ toda a planta).
function groupStringboxByGId(records) {
  const byGid = {};
  (records||[]).forEach(r=>{
    if (!r.GId) return;
    const time = String(r.DateTime||"").slice(11,16);
    const count = sbChannelCount(r.GId);
    if (!byGid[r.GId]) byGid[r.GId] = [];
    byGid[r.GId].push({ time, idc:(r.Idc||[]).slice(0,count) });
  });
  Object.values(byGid).forEach(arr=>arr.sort((a,b)=>a.time.localeCompare(b.time)));
  return byGid;
}

// "SM3/INV3.1.1ST" → { inverter:"SDM3" (grupo/optgroup), pos:"3.1.1", label:"INV3.1.1" (item) }
function combinerMeta(gid) {
  const m = String(gid).match(/INV(\d+)\.(\d+\.\d+)ST$/i);
  if (!m) return { inverter:gid, pos:gid, label:gid };
  const inverter = `SDM${m[1]}`;
  const pos = `${m[1]}.${m[2]}`;
  return { inverter, pos, label:`INV${pos}` };
}

async function fetchStringboxDay(date, isToday, attempt=0) {
  if (!isToday) {
    const cached = localStorage.getItem(SB_CACHE_PREFIX+date);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* cache corrompido, refaz a busca */ }
    }
  }
  const res = await fetch(`/api/stringbox?date=${date}`);
  if (res.status===429 && attempt<1) {
    await new Promise(r=>setTimeout(r,8000));
    return fetchStringboxDay(date, isToday, attempt+1);
  }
  if (!res.ok) {
    const body = await res.json().catch(()=>({}));
    throw new Error(body.error || `Erro ${res.status} ao buscar ${date}`);
  }
  const records = await res.json();
  const parsed = groupStringboxByGId(records);
  if (!isToday) {
    try { localStorage.setItem(SB_CACHE_PREFIX+date, JSON.stringify(parsed)); } catch { /* quota cheia — segue sem cache */ }
  }
  return parsed;
}

function CombinerChart({ records, onPointClick, viewKey }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const viewKeyRef = useRef(null); // identifica a "visão" atual (dia+combinador) — muda só quando o usuário navega
  const cbRef     = useRef(onPointClick);
  const [ready, setReady] = useState(!!window._chartReady);
  useEffect(()=>{ cbRef.current=onPointClick; },[onPointClick]);
  useEffect(()=>{ if(window._chartReady){registerSmartTooltip();setReady(true);return;} loadChartLibs().then(()=>setReady(true)); },[]);

  useEffect(()=>{
    if(!ready||!canvasRef.current) return;
    if(!records.length) {
      if(chartRef.current){chartRef.current.destroy();chartRef.current=null;viewKeyRef.current=null;}
      return;
    }

    const labels = records.map(r=>r.time);
    const channelCount = records.reduce((max,r)=>Math.max(max,r.idc.length),0);
    const datasets = Array.from({length:channelCount},(_,i)=>({
      label:`Combiner ${i+1}`,
      data: records.map(r=>{ const v=r.idc[i]; return (v!=null&&isFinite(v))?v:null; }),
      borderColor: PALETTE[i % PALETTE.length], backgroundColor:"transparent",
      borderWidth:1.5, pointRadius:0, pointHoverRadius:4, tension:0.35, spanGaps:false,
    }));

    // Mesma visão (dia+combinador) de antes — só atualiza os dados, preservando zoom/pan
    // aplicado pelo usuário (destruir e recriar o Chart.js reseta o zoom).
    if (chartRef.current && viewKeyRef.current===viewKey) {
      chartRef.current.data.labels = labels;
      chartRef.current.data.datasets = datasets;
      chartRef.current.update("none");
      return;
    }

    if (chartRef.current) chartRef.current.destroy();
    viewKeyRef.current = viewKey;
    chartRef.current = new window.Chart(canvasRef.current,{
      type:"line", data:{labels,datasets},
      options:{
        responsive:true, maintainAspectRatio:false, animation:false,
        interaction:{mode:"index",intersect:false},
        onClick:(_,els,ch)=>{if(!els.length)return;cbRef.current?.(ch.data.labels[els[0].index]);},
        plugins:{
          legend:{display:true,position:"bottom",labels:{color:"#8595A6",boxWidth:10,font:{size:10}}},
          tooltip:{position:"smart",backgroundColor:"rgba(38,50,68,0.97)",titleColor:"#A7B6C6",bodyColor:"#EAF2FB",
            borderColor:"rgba(46,155,255,0.40)",borderWidth:1,padding:10,
            callbacks:{title:items=>items[0]?.label??"",
              label:ctx=>`  ${ctx.dataset.label}: ${ctx.parsed.y!=null?ctx.parsed.y.toFixed(2)+" A":"—"}`,
              labelTextColor:ctx=>ctx.dataset.borderColor}},
          zoom:{pan:{enabled:true,mode:"xy",threshold:10},
            zoom:{wheel:{enabled:true,mode:"xy"},pinch:{enabled:false},drag:{enabled:false},mode:"xy"}},
        },
        scales:{
          x: timeAxisScale(),
          y:{position:"left",ticks:{color:"#8595A6",font:{size:11},maxTicksLimit:8,callback:v=>v.toFixed(0)+"A"},
            grid:{color:"rgba(148,163,184,0.10)"},border:{color:"rgba(148,163,184,0.22)"},
            title:{display:true,text:"Corrente DC (A)",color:"#A7B6C6",font:{size:11}}},
        },
      },
    });
  },[ready,records,viewKey]);

  useEffect(()=>()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}},[]);

  return(
    <div style={{position:"relative",width:"100%",height:"100%"}}>
      {(!ready||!records.length)&&(
        <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
          color:"var(--color-text-tertiary)",fontSize:13}}>
          {!ready?"Carregando…":"Sem dados para este dia"}
        </div>
      )}
      <canvas ref={canvasRef} role="img" style={{cursor:"crosshair"}} onDoubleClick={()=>chartRef.current?.resetZoom()}/>
    </div>
  );
}

function CombinerPanel({ onLastUpdated, refreshTick, autoSyncTick }) {
  const dates = useMemo(()=>last30Dates(),[]);
  const today = dates[dates.length-1];
  const [dayData, setDayData]   = useState(()=>({..._combinerCache}));   // { [date]: { [GId]: {time,idc[]}[] } } — seedado do cache de módulo
  const [progress, setProgress] = useState({loaded:0,total:dates.length});
  const [selDate, setSelDate]   = useState(today);
  const [selGid, setSelGid]     = useState(null);
  const [fatalError, setFatalError] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [analysisScope, setAnalysisScope] = useState("point"); // "point" | "day"
  const [sortDir, setSortDir] = useState("asc"); // "asc" (menor→maior) | "desc" (maior→menor)

  useEffect(()=>{ setSelectedTime(null); },[selDate]);

  useEffect(()=>{
    // Flag local por execução do efeito — um useRef compartilhado não isolaria
    // corretamente remounts (StrictMode em dev, ou trocar de aba e voltar rápido):
    // o cleanup de uma execução antiga acabaria cancelando a corrida da nova.
    let cancelled = false;
    // "Hoje" sempre revalida; dias já presentes no cache de módulo (de uma visita anterior
    // à aba, ou do auto-sync em segundo plano) não entram na fila — evita esperar o
    // espaçamento de todo o laço de novo só pra reler dado que já temos.
    const pending = dates.slice().reverse().filter(d=>d===today||!_combinerCache[d]);
    setProgress({loaded:0,total:pending.length});
    if (!pending.length) return;

    (async () => {
      let loaded = 0;
      for (const date of pending) {
        if (cancelled) return;
        const isToday = date === today;
        try {
          const parsed = await fetchStringboxDay(date, isToday);
          if (cancelled) return;
          _combinerCache[date] = parsed;
          setDayData(prev=>({...prev,[date]:parsed}));
          if (isToday) onLastUpdated?.(new Date());
        } catch (err) {
          if (loaded===0) setFatalError(err.message);
        }
        loaded++;
        setProgress({loaded, total:pending.length});
        if (date !== pending[pending.length-1]) {
          await new Promise(r=>setTimeout(r, SB_FETCH_SPACING_MS));
        }
      }
    })();

    return ()=>{ cancelled = true; };
    // refreshTick força reexecução (botão "Atualizar") — dias já em cache não geram requisição nova,
    // só "hoje" de fato revalida.
  },[dates, today, onLastUpdated, refreshTick]);

  // Auto-sync (a cada ~15min, roda sempre em segundo plano — ver useAutoSync no App):
  // só relê "hoje" do cache já atualizado por runAutoSync — sem disparar o laço de 30 dias.
  const lastCombinerAutoTickRef = useRef(autoSyncTick);
  useEffect(()=>{
    if (autoSyncTick===lastCombinerAutoTickRef.current) return;
    lastCombinerAutoTickRef.current = autoSyncTick;
    if (_combinerCache[today]) { setDayData(prev=>({...prev,[today]:_combinerCache[today]})); onLastUpdated?.(new Date()); }
  },[autoSyncTick, today, onLastUpdated]);

  useEffect(()=>{ if(Object.keys(dayData).length>0 && fatalError) setFatalError(null); },[dayData, fatalError]);

  const allGids = useMemo(()=>{
    const s = new Set();
    Object.values(dayData).forEach(byGid=>Object.keys(byGid).forEach(g=>s.add(g)));
    return [...s].sort();
  },[dayData]);

  useEffect(()=>{ if(!selGid && allGids.length) setSelGid(allGids[0]); },[allGids, selGid]);

  const gidsByInverter = useMemo(()=>{
    const map = {};
    allGids.forEach(g=>{
      const {inverter} = combinerMeta(g);
      if (!map[inverter]) map[inverter] = [];
      map[inverter].push(g);
    });
    return map;
  },[allGids]);

  const dateIdx = dates.indexOf(selDate);
  const goPrev = () => { if(dateIdx>0) setSelDate(dates[dateIdx-1]); };
  const goNext = () => { if(dateIdx<dates.length-1) setSelDate(dates[dateIdx+1]); };

  const dateLoaded = !!dayData[selDate];
  const records = (selGid && dayData[selDate]?.[selGid]) || [];

  const summary = useMemo(()=>{
    if (!records.length) return null;
    const last = records[records.length-1];
    const vals = last.idc.map((v,i)=>({i,v})).filter(x=>x.v!=null&&isFinite(x.v));
    if (!vals.length) return null;
    const min = vals.reduce((a,b)=>b.v<a.v?b:a);
    const max = vals.reduce((a,b)=>b.v>a.v?b:a);
    return { time:last.time, min, max };
  },[records]);

  // Ranking de todos os 30 combinadores no horário clicado, separado por 16 vs 17 entradas
  // (comparar direto entre grupos seria injusto — um combinador de 17 soma mais só por ter mais canais).
  const pointAnalysis = useMemo(()=>{
    if (!selectedTime) return null;
    const byGid = dayData[selDate];
    if (!byGid) return null;
    const rows = Object.entries(byGid).map(([gid,recs])=>{
      const rec = recs.find(r=>r.time===selectedTime);
      if (!rec) return null;
      const vals = rec.idc.filter(v=>v!=null&&isFinite(v));
      if (!vals.length) return null;
      return { gid, label:combinerMeta(gid).label, channelCount:rec.idc.length,
        avg: vals.reduce((s,v)=>s+v,0)/vals.length, values:rec.idc };
    }).filter(Boolean);
    return {
      cohort16: rows.filter(r=>r.channelCount===16).sort((a,b)=>a.avg-b.avg),
      cohort17: rows.filter(r=>r.channelCount===17).sort((a,b)=>a.avg-b.avg),
    };
  },[selectedTime, dayData, selDate]);

  // Mesma comparação, mas usando a média de cada entrada ao longo do dia inteiro (não só um horário)
  const dayAnalysis = useMemo(()=>{
    const byGid = dayData[selDate];
    if (!byGid) return null;
    const rows = Object.entries(byGid).map(([gid,recs])=>{
      if (!recs.length) return null;
      const channelCount = recs.reduce((max,r)=>Math.max(max,r.idc.length),0);
      const sums = Array(channelCount).fill(0), counts = Array(channelCount).fill(0);
      recs.forEach(r=>r.idc.forEach((v,i)=>{ if(v!=null&&isFinite(v)){ sums[i]+=v; counts[i]++; } }));
      const channelAvgs = sums.map((s,i)=>counts[i]>0?s/counts[i]:null);
      const vals = channelAvgs.filter(v=>v!=null);
      if (!vals.length) return null;
      return { gid, label:combinerMeta(gid).label, channelCount,
        avg: vals.reduce((s,v)=>s+v,0)/vals.length, values:channelAvgs };
    }).filter(Boolean);
    return {
      cohort16: rows.filter(r=>r.channelCount===16).sort((a,b)=>a.avg-b.avg),
      cohort17: rows.filter(r=>r.channelCount===17).sort((a,b)=>a.avg-b.avg),
    };
  },[dayData, selDate]);

  const rankingAnalysis = analysisScope==="day" ? dayAnalysis : pointAnalysis;

  // Destaque de cada coluna: o combinador clicado na lista (se pertencer a esse grupo), senão o pior (#1)
  function worstEntradas(row) {
    if (!row) return [];
    return row.values.map((v,i)=>({i,v})).filter(x=>x.v!=null&&isFinite(x.v)).sort((a,b)=>a.v-b.v).slice(0,4);
  }
  function highlightFor(arr) {
    if (!arr || !arr.length) return null;
    const picked = arr.find(r=>r.gid===selGid) || arr[0];
    return { ...picked, isWorst: picked.gid===arr[0].gid, worstEntradas: worstEntradas(picked) };
  }

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",padding:"10px 16px 8px",minHeight:0}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexShrink:0,flexWrap:"wrap"}}>

        {/* Navegação de data (últimos 30 dias) */}
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <button onClick={goPrev} disabled={dateIdx<=0}
            style={{background:"none",border:"none",cursor:dateIdx>0?"pointer":"default",fontSize:15,
              color:dateIdx>0?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
            <i className="ti ti-chevron-left"/>
          </button>
          <span style={{fontSize:13,fontWeight:600,minWidth:88,textAlign:"center",fontFamily:"var(--font-mono)"}}>
            {fmtYmd(selDate)}
          </span>
          <button onClick={goNext} disabled={dateIdx>=dates.length-1}
            style={{background:"none",border:"none",cursor:dateIdx<dates.length-1?"pointer":"default",fontSize:15,
              color:dateIdx<dates.length-1?"var(--color-text-secondary)":"var(--color-text-tertiary)",padding:"2px 4px"}}>
            <i className="ti ti-chevron-right"/>
          </button>
          {!dateLoaded&&(
            <span style={{fontSize:13,color:"var(--color-text-tertiary)",display:"flex",alignItems:"center",gap:4}}>
              <i className="ti ti-loader-2" style={{fontSize:13}}/> carregando…
            </span>
          )}
        </div>

        {/* Seletor de combinador */}
        <select value={selGid||""} onChange={e=>setSelGid(e.target.value)} disabled={!allGids.length}
          style={{fontSize:12,maxWidth:220,padding:"5px 10px",borderRadius:7,cursor:"pointer",outline:"none",
            background:"#ffffff",color:"#182449",border:"1px solid rgba(24,36,73,0.14)"}}>
          {Object.entries(gidsByInverter).map(([inv,gids])=>(
            <optgroup key={inv} label={inv} style={{background:"#ffffff",color:"#5c6788"}}>
              {gids.map(g=>(
                <option key={g} value={g} style={{background:"#ffffff",color:"#182449"}}>
                  {combinerMeta(g).label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Progresso do backfill de 30 dias */}
        {progress.loaded<progress.total&&(
          <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"var(--color-text-tertiary)"}}>
            <div style={{width:80,height:5,borderRadius:3,background:"var(--color-background-secondary)",overflow:"hidden"}}>
              <div style={{width:`${(progress.loaded/progress.total*100).toFixed(0)}%`,height:"100%",
                background:"#1656d6",transition:"width 0.3s"}}/>
            </div>
            <span>histórico {progress.loaded}/{progress.total}</span>
          </div>
        )}

        {/* Resumo da última leitura do dia selecionado */}
        {summary&&(
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:14,fontSize:13,
            color:"var(--color-text-secondary)",flexWrap:"wrap"}}>
            <span style={{color:"#4CAF50"}}>▲ Combiner {summary.max.i+1} ({summary.max.v.toFixed(1)}A)</span>
            <span style={{color:"#F44336"}}>▼ Combiner {summary.min.i+1} ({summary.min.v.toFixed(1)}A)</span>
            {selectedTime&&(
              <span style={{color:"#1656d6",display:"inline-flex",alignItems:"center",gap:4}}>
                <i className="ti ti-map-pin" style={{fontSize:13}}/><strong>{selectedTime}</strong>
                <button onClick={()=>setSelectedTime(null)}
                  style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#1656d6",padding:0,lineHeight:1,marginLeft:1}}>
                  <i className="ti ti-x"/>
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Gráfico */}
      <div style={{flex:(analysisScope==="day"||selectedTime)?"1 1 58%":"1 1 auto",minHeight:0}}>
        {fatalError?(
          <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
            gap:10,color:"var(--color-text-tertiary)",textAlign:"center"}}>
            <i className="ti ti-plug-connected-x" style={{fontSize:40}}/>
            <div style={{fontSize:13,maxWidth:380}}>{fatalError}</div>
          </div>
        ):!allGids.length?(
          <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
            gap:10,color:"var(--color-text-tertiary)",textAlign:"center"}}>
            <i className="ti ti-plug-connected" style={{fontSize:40}}/>
            <div style={{fontSize:13}}>Carregando combiners da API…</div>
          </div>
        ):(
          <CombinerChart records={records} onPointClick={setSelectedTime} viewKey={`${selDate}|${selGid}`}/>
        )}
      </div>

      {/* Análise: ranking dos 30 combinadores, separado por 16 vs 17 entradas */}
      <div style={{flexShrink:0,paddingTop:8,marginTop:analysisScope==="day"||selectedTime?8:0,
        display:"flex",alignItems:"center",gap:10}}>
        <div style={{display:"flex",gap:2,background:"var(--color-background-secondary)",padding:3,borderRadius:8,flexShrink:0}}>
          {[{id:"point",label:"Ponto clicado"},{id:"day",label:"Dia inteiro"}].map(v=>(
            <button key={v.id} onClick={()=>setAnalysisScope(v.id)}
              title={v.id==="point"&&analysisScope==="point"&&!selectedTime?"Clique num ponto do gráfico para comparar todos os combinadores nesse horário":undefined}
              style={{padding:"4px 11px",fontSize:13,cursor:"pointer",borderRadius:6,border:"none",
                display:"flex",alignItems:"center",gap:4,
                background:analysisScope===v.id?"#1656d6":"transparent",
                color:analysisScope===v.id?"#fff":"var(--color-text-secondary)",
                fontWeight:analysisScope===v.id?600:400,transition:"all 0.15s"}}>
              {v.label}
              {v.id==="point"&&analysisScope==="point"&&!selectedTime&&(
                <i className="ti ti-hand-click" style={{fontSize:13}}/>
              )}
            </button>
          ))}
        </div>
        {rankingAnalysis&&(analysisScope==="day"||selectedTime)&&(
          <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}
            title={sortDir==="asc"?"Ordenando: menor → maior (clique p/ inverter)":"Ordenando: maior → menor (clique p/ inverter)"}
            style={{display:"flex",alignItems:"center",gap:4,fontSize:13,padding:"4px 9px",cursor:"pointer",
              borderRadius:6,border:"0.5px solid var(--color-border-secondary)",
              background:"var(--color-background-secondary)",color:"var(--color-text-secondary)"}}>
            <i className={`ti ${sortDir==="asc"?"ti-sort-ascending":"ti-sort-descending"}`} style={{fontSize:13}}/>
            {sortDir==="asc"?"Menor → maior":"Maior → menor"}
          </button>
        )}
      </div>

      {rankingAnalysis&&(analysisScope==="day"||selectedTime)&&(
        <div style={{flex:"0 0 36%",display:"flex",gap:12,paddingTop:8,minHeight:0}}>
          {[{title:"17 entradas",arr:rankingAnalysis.cohort17},
            {title:"16 entradas",arr:rankingAnalysis.cohort16}].map(({title,arr})=>{
            const highlight = highlightFor(arr);
            return(
            <div key={title} style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
              {highlight&&(
                <div style={{flexShrink:0,marginBottom:6,padding:"6px 8px",borderRadius:6,
                  background:"rgba(244,67,54,0.08)",border:"1px solid rgba(244,67,54,0.28)"}}>
                  <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>
                    {highlight.isWorst?"Menor corrente: ":"Selecionado: "}
                    <strong style={{color:"#F44336"}}>{highlight.label}</strong>
                    <span style={{color:"var(--color-text-tertiary)"}}> ({highlight.avg.toFixed(2)} A méd.)</span>
                  </div>
                  <div style={{fontSize:13,color:"var(--color-text-tertiary)",marginTop:2,display:"flex",alignItems:"baseline",gap:5,flexWrap:"wrap"}}>
                    <span style={{color:"#F44336",fontWeight:700,flexShrink:0}}>▼4</span>
                    {highlight.worstEntradas.map((e,i)=>(
                      <span key={e.i} style={{color:"var(--color-text-secondary)"}}>
                        {i>0&&", "}Combiner {e.i+1} ({e.v.toFixed(2)}A)
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div style={{overflowY:"auto",flex:1,display:"flex",flexDirection:"column",gap:3}}>
                {!arr.length?(
                  <div style={{fontSize:13,color:"var(--color-text-tertiary)"}}>Sem dados</div>
                ):(sortDir==="asc"?arr:[...arr].reverse()).map((r,i)=>{
                  const worst = r.gid===arr[0]?.gid; // sempre a menor corrente, independe da ordem exibida
                  const isSelected = r.gid===selGid;
                  return(
                    <div key={r.gid} onClick={()=>setSelGid(r.gid)}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"3px 8px",borderRadius:5,cursor:"pointer",
                        background:isSelected?"rgba(46,155,255,0.14)":worst?"rgba(244,67,54,0.10)":"var(--color-background-secondary)",
                        border:isSelected?"1px solid rgba(46,155,255,0.45)":"1px solid transparent"}}>
                      <span style={{fontSize:13,color:"var(--color-text-tertiary)",fontWeight:700,minWidth:16,textAlign:"center"}}>#{i+1}</span>
                      <span style={{fontSize:13,fontWeight:600,flex:1,overflow:"hidden",textOverflow:"ellipsis",
                        whiteSpace:"nowrap",color:"var(--color-text-primary)"}} title={r.label}>{r.label}</span>
                      <span style={{fontSize:13,fontFamily:"var(--font-mono)",fontWeight:700,flexShrink:0,
                        color:worst?"#F44336":"var(--color-text-secondary)"}}>{r.avg.toFixed(2)} A</span>
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MonitoramentoView = forwardRef(function MonitoramentoView({ activeTab, onRefreshStateChange }, ref) {
  return <ErrorBoundary><MonitoramentoInner ref={ref} activeTab={activeTab} onRefreshStateChange={onRefreshStateChange}/></ErrorBoundary>;
});
export default MonitoramentoView;
