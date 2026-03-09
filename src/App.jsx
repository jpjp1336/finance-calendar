import { useState, useMemo, useEffect, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc } from "firebase/firestore";

// ─── Firebase ────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDNKC1T3aEkrVWAV2xdRjTgM_ZOS1CuSWU",
  authDomain: "finance-calendar-16406.firebaseapp.com",
  projectId: "finance-calendar-16406",
  storageBucket: "finance-calendar-16406.firebasestorage.app",
  messagingSenderId: "625091931239",
  appId: "1:625091931239:web:d9dff90ac41ac3993278c2"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ─── Utils ───────────────────────────────────────────────────
const fmt = n => n ? Math.round(n).toLocaleString("ko-KR") : "0";
const fmtM = n => {
  if (!n) return "0";
  if (n >= 100000000) return `${(n/100000000).toFixed(1)}억`;
  if (n >= 10000000)  return `${Math.round(n/10000000)}천만`;
  if (n >= 10000)     return `${Math.round(n/10000)}만`;
  return fmt(n);
};
const TODAY      = new Date();
const TODAY_STR  = `${TODAY.getFullYear()}-${String(TODAY.getMonth()+1).padStart(2,"0")}-${String(TODAY.getDate()).padStart(2,"0")}`;

// 주말이면 다음 월요일로 조정 (해당 월 안에 있으면)
function adjustToWeekday(year, month, day, daysInMonth) {
  const d = new Date(year, month, day);
  const dow = d.getDay();
  let adjusted = day;
  if (dow === 6) adjusted = day + 2; // 토 → 월
  if (dow === 0) adjusted = day + 1; // 일 → 월
  return Math.min(adjusted, daysInMonth);
}

// ─── 대출 스케줄 계산 ─────────────────────────────────────────
function calcSchedule(loan) {
  const { type, balance, rate, maturity, payDay, startDate, totalMonths, graceMonths, repayMonths } = loan;
  const r = rate / 100 / 12;
  const schedule = [];
  const start = new Date(startDate || new Date());
  const mkDate = (y, m, d) => {
    const dt = new Date(y, m, d);
    const dow = dt.getDay();
    let adjDay = d;
    if (dow === 6) adjDay = d + 2;
    if (dow === 0) adjDay = d + 1;
    const adjDt = new Date(y, m, adjDay);
    return `${adjDt.getFullYear()}-${String(adjDt.getMonth()+1).padStart(2,"0")}-${String(adjDt.getDate()).padStart(2,"0")}`;
  };

  if (type === "원금균등") {
    const months = totalMonths || 60; let b = balance;
    const p = Math.round(balance / months);
    for (let i = 0; i < months && b > 0; i++) {
      const d = new Date(start.getFullYear(), start.getMonth()+i, payDay);
      const principal = i===months-1 ? b : Math.min(p,b);
      const interest = Math.round(b*r);
      b = Math.max(0, b-principal);
      schedule.push({ date: mkDate(d.getFullYear(),d.getMonth(),payDay), principal, interest, total:principal+interest, balance:b });
    }
  } else if (type === "원리금균등") {
    const months = totalMonths || 60; let b = balance;
    const monthly = r>0 ? Math.round(b*r/(1-Math.pow(1+r,-months))) : Math.round(b/months);
    for (let i = 0; i < months && b > 0; i++) {
      const d = new Date(start.getFullYear(), start.getMonth()+i, payDay);
      const interest = Math.round(b*r);
      const principal = Math.min(monthly-interest, b);
      b = Math.max(0, b-principal);
      schedule.push({ date: mkDate(d.getFullYear(),d.getMonth(),payDay), principal, interest, total:principal+interest, balance:b });
    }
  } else if (type === "이자만" || type === "만기일시상환") {
    const end = new Date(maturity);
    let d = new Date(start.getFullYear(), start.getMonth(), payDay);
    while (d <= end) {
      const interest = Math.round(balance*r);
      schedule.push({ date: mkDate(d.getFullYear(),d.getMonth(),payDay), principal:0, interest, total:interest, balance });
      d = new Date(d.getFullYear(), d.getMonth()+1, payDay);
    }
  } else if (type === "거치후원금균등") {
    const grace = graceMonths||36; const repay = repayMonths||48; let b = balance;
    for (let i = 0; i < grace; i++) {
      const d = new Date(start.getFullYear(), start.getMonth()+i, payDay);
      schedule.push({ date: mkDate(d.getFullYear(),d.getMonth(),payDay), principal:0, interest:Math.round(b*r), total:Math.round(b*r), balance:b });
    }
    const p = Math.round(b/repay);
    for (let i = 0; i < repay && b > 0; i++) {
      const d = new Date(start.getFullYear(), start.getMonth()+grace+i, payDay);
      const principal = i===repay-1 ? b : Math.min(p,b);
      const interest = Math.round(b*r);
      b = Math.max(0, b-principal);
      schedule.push({ date: mkDate(d.getFullYear(),d.getMonth(),payDay), principal, interest, total:principal+interest, balance:b });
    }
  }
  return schedule;
}

function getLoanWithSchedule(loan) {
  if (loan.type==="수동" && loan.schedule) return loan;
  return { ...loan, schedule: calcSchedule(loan) };
}

// ─── 오너 전용 데이터 ────────────────────────────────────────
const OWNER_UID = "EXRAhy2hx0WWmh1dcU7xMV1W8rL2";

const OWNER_CARDS = [
  { id:1,                company:"현대카드",   limit:2200000,  payDay:12, billing:342788,  color:"#059669" },
  { id:1772864633576,    company:"신한카드",   limit:7500000,  payDay:25, billing:3979800, color:"#2563eb" },
  { id:1772864882224,    company:"삼성카드",   limit:16000000, payDay:26, billing:9560440, color:"#2563eb" },
  { id:1772864965988,    company:"하나카드",   limit:5000000,  payDay:13, billing:706790,  color:"#059669" },
  { id:1772865082800,    company:"KB국민카드", limit:20000000, payDay:20, billing:5325390, color:"#d97706" },
  { id:1772865111030,    company:"씨티카드",   limit:30000000, payDay:20, billing:0,       color:"#2563eb" },
  { id:1772865154382,    company:"롯데카드",   limit:50000000, payDay:14, billing:8360890, color:"#dc2626" },
  { id:1772865199536,    company:"우리카드",   limit:20000000, payDay:14, billing:0,       color:"#2563eb" },
  { id:1772865317906,    company:"NH농협카드", limit:13000000, payDay:14, billing:110890,  color:"#0891b2" },
  { id:1772865460949,    company:"KJ광주카드", limit:14000000, payDay:15, billing:452680,  color:"#db2777" },
];

const OWNER_LOANS = [
  { id:1, name:"하나은행 운전자금 이차보전", bank:"하나은행", balance:10000000, rate:3.609, maturity:"2026-12-07", payDay:7, color:"#3B82F6", type:"수동",
    schedule:[
      {date:"2026-03-07",principal:2500000,interest:27685,total:2527685,balance:7500000},
      {date:"2026-06-07",principal:2500000,interest:22556,total:2522556,balance:5000000},
      {date:"2026-09-07",principal:2500000,interest:15038,total:2515038,balance:2500000},
      {date:"2026-12-07",principal:2500000,interest:7519, total:2507519,balance:0},
    ]},
  { id:2,  name:"하나은행 일반운전자금",    bank:"하나은행",   balance:9166684,   rate:5.719, maturity:"2027-12-07", payDay:7,  color:"#6366F1", type:"원금균등",       totalMonths:22,  startDate:"2026-03-01" },
  { id:3,  name:"하나 e소상공인 대환",      bank:"하나은행",   balance:20000000,  rate:4.842, maturity:"2033-03-28", payDay:28, color:"#8B5CF6", type:"거치후원금균등", graceMonths:1, repayMonths:84, startDate:"2026-03-01" },
  { id:4,  name:"흥국생명 계약자대출",      bank:"흥국생명",   balance:34689730,  rate:10.44, maturity:"2030-04-20", payDay:20, color:"#EC4899", type:"원리금균등",     totalMonths:50,  startDate:"2026-03-01" },
  { id:5,  name:"농협",                     bank:"농협",       balance:10000000,  rate:3.37,  maturity:"2032-09-24", payDay:24, color:"#10B981", type:"원금균등",       totalMonths:78,  startDate:"2026-10-01" },
  { id:6,  name:"소상공인진흥공단",         bank:"소진공",     balance:58705338,  rate:2.11,  maturity:"2035-07-05", payDay:5,  color:"#F59E0B", type:"원금균등",       totalMonths:112, startDate:"2026-04-01" },
  { id:7,  name:"KB카드론 (양해선)",         bank:"KB국민카드", balance:36118479,  rate:10.31, maturity:"2029-02-15", payDay:15, color:"#EF4444", type:"원리금균등",     totalMonths:36,  startDate:"2026-03-01" },
  { id:8,  name:"KB 지식산업센터 대출",     bank:"KB국민은행", balance:186000000, rate:5.7,   maturity:"2026-04-02", payDay:4,  color:"#F97316", type:"만기일시상환",   startDate:"2026-03-01",
    warning:"만기연장 예정 - 즉시 은행 협의 필요 (031-445-1111)" },
  { id:9,  name:"차량할부 (레이)",          bank:"캐피탈",     balance:2230971,   rate:2.9,   maturity:"2026-11-20", payDay:20, color:"#06B6D4", type:"원금균등",       totalMonths:9,   startDate:"2026-03-01" },
  { id:10, name:"차량할부 (셀토스)",        bank:"캐피탈",     balance:5439550,   rate:2.9,   maturity:"2027-02-25", payDay:25, color:"#84CC16", type:"원금균등",       totalMonths:12,  startDate:"2026-03-01" },
];

// ─── 기본 데이터 ──────────────────────────────────────────────
const DEFAULT_CARDS = [
  { id:1, company:"신한카드",   limit:5000000,  payDay:15, billing:0, color:"#2563eb" },
  { id:2, company:"현대카드",   limit:3000000,  payDay:12, billing:0, color:"#059669" },
  { id:3, company:"KB국민카드", limit:10000000, payDay:20, billing:0, color:"#d97706" },
];
const DEFAULT_COSTS = [
  { id:1, name:"사무실 임대료",  payDay:5,  amount:1500000, color:"#10B981", category:"임차료" },
  { id:2, name:"차량 리스",      payDay:10, amount:650000,  color:"#3B82F6", category:"임차료" },
  { id:3, name:"인터넷/전화",    payDay:15, amount:120000,  color:"#F59E0B", category:"통신비" },
  { id:4, name:"사업장 보험료",  payDay:20, amount:350000,  color:"#8B5CF6", category:"보험료" },
  { id:5, name:"회계/세무",      payDay:25, amount:300000,  color:"#EC4899", category:"지급수수료" },
  { id:6, name:"직원 급여",      payDay:10, amount:2000000, color:"#06B6D4", category:"인건비" },
  { id:7, name:"택배비",         payDay:25, amount:300000,  color:"#F97316", category:"운반비" },
];
const DEFAULT_LOANS = [
  { id:1, name:"은행 신용대출", bank:"은행명", balance:10000000, rate:4.5, maturity:"2027-12-31", payDay:15, color:"#3B82F6", type:"원금균등", totalMonths:24, startDate:"2026-01-01" },
  { id:2, name:"주택담보대출",  bank:"은행명", balance:50000000, rate:3.5, maturity:"2035-12-31", payDay:25, color:"#8B5CF6", type:"원리금균등", totalMonths:120, startDate:"2026-01-01" },
];

const DEFAULT_ACCOUNTS = [
  { id:1, name:"사업자통장", balance:0, color:"#3B82F6" },
  { id:2, name:"개인통장",   balance:0, color:"#10B981" },
];

// ─── 테마 ────────────────────────────────────────────────────
const DARK = {
  bg:"#070B18", bg2:"#0F1629", bg3:"#141D35",
  border:"#1E2D4A", border2:"#2A3F5F",
  text:"#E2E8F0", sub:"#94A3B8", muted:"#475569",
  acc:"#3B82F6", ok:"#10B981", warn:"#F59E0B", danger:"#EF4444",
  hdr:"linear-gradient(135deg,#0D1230,#141B3A)",
  card:"#0F1629", inp:"#070B18",
  ledgerBg:"#0A0E20", ledgerRow:"#0F1629", ledgerAlt:"#0D1525",
};
const LIGHT = {
  bg:"#F0F4FA", bg2:"#FFFFFF", bg3:"#E8EFF8",
  border:"#D1DCF0", border2:"#B8CCE8",
  text:"#1A2A42", sub:"#4A6FA5", muted:"#8AAAC8",
  acc:"#2563EB", ok:"#059669", warn:"#D97706", danger:"#DC2626",
  hdr:"linear-gradient(135deg,#1E3A6E,#2D5499)",
  card:"#FFFFFF", inp:"#F0F4FA",
  ledgerBg:"#E8EFF8", ledgerRow:"#FFFFFF", ledgerAlt:"#F5F8FD",
};

// ─── 계좌 모달 ───────────────────────────────────────────────
function AccountModal({ account, T, onSave, onClose }) {
  const COLORS = ["#3B82F6","#10B981","#F59E0B","#8B5CF6","#EC4899","#EF4444","#F97316","#14B8A6"];
  const [form, setForm] = useState({ name:"", balance:0, color:COLORS[0], ...account });
  const inp = { width:"100%", background:T.inp, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 12px", color:T.text, fontSize:13, boxSizing:"border-box", fontFamily:"inherit" };
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:"min(400px,95vw)" }}>
        <div style={{ fontSize:16,fontWeight:900,color:T.text,marginBottom:16 }}>{account?"✏️ 계좌 수정":"🏦 계좌 추가"}</div>
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>계좌명</div>
          <input style={inp} placeholder="예: 사업자통장, 하나은행" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>현재 잔액 (원)</div>
          <input style={inp} type="number" placeholder="0" value={form.balance} onChange={e=>setForm(f=>({...f,balance:Number(e.target.value)}))}/>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:8 }}>색상</div>
          <div style={{ display:"flex",gap:8 }}>
            {COLORS.map(c=><div key={c} onClick={()=>setForm(f=>({...f,color:c}))} style={{ width:26,height:26,borderRadius:6,background:c,cursor:"pointer",border:form.color===c?"3px solid "+T.text:"3px solid transparent" }}/>)}
          </div>
        </div>
        <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer",color:T.sub }}>취소</button>
          <button onClick={()=>{if(!form.name)return alert("계좌명을 입력해주세요!");onSave({...form,id:account?.id||Date.now()});}} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ─── 로그인 화면 ──────────────────────────────────────────────
function LoginScreen({ dark }) {
  const T = dark ? DARK : LIGHT;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const handleLogin = async () => {
    setLoading(true); setError("");
    try { await signInWithPopup(auth, googleProvider); }
    catch(e) { setError("로그인 중 오류가 발생했습니다."); }
    setLoading(false);
  };
  return (
    <div style={{ minHeight:"100vh", background:T.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"'Noto Sans KR',sans-serif" }}>
      <div style={{ textAlign:"center", marginBottom:40 }}>
        <div style={{ width:72, height:72, borderRadius:20, background:"linear-gradient(135deg,#3B82F6,#8B5CF6)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:36, margin:"0 auto 20px" }}>💰</div>
        <div style={{ fontSize:26, fontWeight:900, color:T.text }}>통합 재무 캘린더</div>
        <div style={{ fontSize:13, color:T.muted, marginTop:8 }}>카드 결제 · 대출 납부 · 사업 고정비</div>
      </div>
      <button onClick={handleLogin} disabled={loading} style={{ display:"flex", alignItems:"center", gap:12, background:T.bg2, color:T.text, border:`1px solid ${T.border}`, borderRadius:14, padding:"15px 30px", fontSize:15, fontWeight:700, cursor:loading?"not-allowed":"pointer", boxShadow:"0 4px 20px rgba(0,0,0,0.15)", transition:"all 0.2s" }}>
        <svg width="22" height="22" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        {loading ? "로그인 중..." : "Google로 로그인"}
      </button>
      {error && <div style={{ marginTop:16, color:T.danger, fontSize:13 }}>{error}</div>}
    </div>
  );
}

// ─── 메모 추가 모달 ───────────────────────────────────────────
function MemoModal({ date, T, accounts, onSave, onClose }) {
  const [form, setForm] = useState({ label:"", amount:"", type:"지출", color:"#EF4444", accountId: accounts[0]?.id||null });
  const COLORS = ["#EF4444","#3B82F6","#10B981","#F59E0B","#8B5CF6","#EC4899","#F97316","#14B8A6"];
  const inp = { width:"100%", background:T.inp, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 12px", color:T.text, fontSize:13, boxSizing:"border-box", fontFamily:"inherit" };
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:"min(400px,95vw)" }}>
        <div style={{ fontSize:16,fontWeight:900,color:T.text,marginBottom:16 }}>✏️ {date} 기록 추가</div>
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>항목명</div>
          <input style={inp} placeholder="예: 쿠팡 선정산, 임대료" value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))}/>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
          <div>
            <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>금액 (원)</div>
            <input style={inp} type="number" placeholder="예: 3000000" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))}/>
          </div>
          <div>
            <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>구분</div>
            <select style={inp} value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
              <option value="수입">💚 수입</option>
              <option value="지출">🔴 지출</option>
            </select>
          </div>
        </div>
        {accounts.length>0 && (
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>계좌</div>
            <select style={inp} value={form.accountId||""} onChange={e=>setForm(f=>({...f,accountId:Number(e.target.value)||null}))}>
              <option value="">계좌 선택 안 함</option>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:8 }}>색상</div>
          <div style={{ display:"flex",gap:8 }}>
            {COLORS.map(c=><div key={c} onClick={()=>setForm(f=>({...f,color:c}))} style={{ width:26,height:26,borderRadius:6,background:c,cursor:"pointer",border:form.color===c?"3px solid "+T.text:"3px solid transparent" }}/>)}
          </div>
        </div>
        <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer",color:T.sub }}>취소</button>
          <button onClick={()=>{
            if (!form.label||!form.amount) return alert("항목명과 금액을 입력해주세요!");
            onSave({ id:Date.now(), date, label:form.label, amount:Number(form.amount), type:form.type, color:form.color, icon:form.type==="수입"?"💚":"🔴", accountId:form.accountId });
          }} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ─── 카드 모달 ────────────────────────────────────────────────
function CardModal({ card, T, onSave, onClose }) {
  const COS = ["BC카드","KB국민카드","NH농협카드","롯데카드","삼성카드","신한카드","씨티카드","우리카드","컬리카드","하나카드","현대카드","KJ광주카드"];
  const COLORS = ["#2563eb","#059669","#d97706","#7c3aed","#db2777","#0891b2","#65a30d","#dc2626","#3B82F6","#EC4899","#10B981","#F97316"];
  const [form, setForm] = useState({ company:"",limit:5000000,payDay:15,billing:0,color:COLORS[0],...card });
  const inp = { width:"100%", background:T.inp, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 12px", color:T.text, fontSize:13, boxSizing:"border-box", fontFamily:"inherit" };
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:"min(420px,95vw)" }}>
        <div style={{ fontSize:16,fontWeight:900,color:T.text,marginBottom:16 }}>{card?"✏️ 카드 수정":"💳 카드 추가"}</div>
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>카드사</div>
          <select style={inp} value={form.company} onChange={e=>setForm(f=>({...f,company:e.target.value}))}>
            <option value="">선택하세요</option>
            {COS.map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
          <div><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>한도 (원)</div><input style={inp} type="number" value={form.limit} onChange={e=>setForm(f=>({...f,limit:Number(e.target.value)}))}/></div>
          <div><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>결제일</div><input style={inp} type="number" min="1" max="28" value={form.payDay} onChange={e=>setForm(f=>({...f,payDay:Number(e.target.value)}))}/></div>
        </div>
        <div style={{ marginBottom:14 }}><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>이번 달 청구액 (원)</div><input style={inp} type="number" value={form.billing} onChange={e=>setForm(f=>({...f,billing:Number(e.target.value)}))}/></div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:8 }}>색상</div>
          <div style={{ display:"flex",gap:7,flexWrap:"wrap" }}>
            {COLORS.map(c=><div key={c} onClick={()=>setForm(f=>({...f,color:c}))} style={{ width:26,height:26,borderRadius:6,background:c,cursor:"pointer",border:form.color===c?"3px solid "+T.text:"3px solid transparent" }}/>)}
          </div>
        </div>
        <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer",color:T.sub }}>취소</button>
          <button onClick={()=>{if(!form.company)return alert("카드사를 선택해주세요!");onSave({...form,id:card?.id||Date.now()});}} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ─── 대출 모달 ──────────────────────────────────────────────
function LoanModal({ loan, T, onSave, onClose }) {
  const COLORS = ["#3B82F6","#6366F1","#8B5CF6","#EC4899","#EF4444","#F97316","#F59E0B","#10B981","#06B6D4","#84CC16"];
  const TYPES = ["원금균등","원리금균등","이자만","만기일시상환","거치후원금균등"];
  const today = new Date().toISOString().slice(0,7) + "-01";
  const [form, setForm] = useState({
    name:"", bank:"", balance:"", rate:"", maturity:"", payDay:"",
    type:"원금균등", totalMonths:"", graceMonths:"", repayMonths:"",
    startDate:today, warning:"", color:COLORS[0],
    ...loan,
    balance: loan?.balance||"",
    rate: loan?.rate||"",
    payDay: loan?.payDay||"",
    totalMonths: loan?.totalMonths||"",
    graceMonths: loan?.graceMonths||"",
    repayMonths: loan?.repayMonths||"",
  });
  const inp = { width:"100%", background:T.inp, border:`1px solid ${T.border}`, borderRadius:8, padding:"9px 12px", color:T.text, fontSize:13, boxSizing:"border-box", fontFamily:"inherit" };
  const lbl = { fontSize:11, color:T.muted, fontWeight:700, marginBottom:4, display:"block" };
  const needsMonths = ["원금균등","원리금균등"].includes(form.type);
  const isGrace = form.type === "거치후원금균등";
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"20px 0" }}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:"min(480px,95vw)" }}>
        <div style={{ fontSize:16,fontWeight:900,color:T.text,marginBottom:16 }}>{loan?"✏️ 대출 수정":"🏦 대출 추가"}</div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
          <div style={{ gridColumn:"1/-1" }}><label style={lbl}>대출명 *</label><input style={inp} placeholder="예: 하나은행 운전자금" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></div>
          <div><label style={lbl}>은행명</label><input style={inp} placeholder="예: 하나은행" value={form.bank} onChange={e=>setForm(f=>({...f,bank:e.target.value}))}/></div>
          <div><label style={lbl}>현재 잔액 (원) *</label><input style={inp} type="number" placeholder="10000000" value={form.balance} onChange={e=>setForm(f=>({...f,balance:e.target.value}))}/></div>
          <div><label style={lbl}>연이율 (%)</label><input style={inp} type="number" step="0.001" placeholder="4.5" value={form.rate} onChange={e=>setForm(f=>({...f,rate:e.target.value}))}/></div>
          <div><label style={lbl}>납부일 (매월)</label><input style={inp} type="number" min="1" max="31" placeholder="15" value={form.payDay} onChange={e=>setForm(f=>({...f,payDay:e.target.value}))}/></div>
          <div><label style={lbl}>만기일</label><input style={inp} type="date" value={form.maturity} onChange={e=>setForm(f=>({...f,maturity:e.target.value}))}/></div>
          <div><label style={lbl}>상환 시작일</label><input style={inp} type="date" value={form.startDate} onChange={e=>setForm(f=>({...f,startDate:e.target.value}))}/></div>
          <div style={{ gridColumn:"1/-1" }}><label style={lbl}>상환 방식</label>
            <select style={inp} value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
              {TYPES.map(t=><option key={t}>{t}</option>)}
            </select>
          </div>
          {needsMonths && <div><label style={lbl}>총 납부 개월</label><input style={inp} type="number" placeholder="60" value={form.totalMonths} onChange={e=>setForm(f=>({...f,totalMonths:e.target.value}))}/></div>}
          {isGrace && <>
            <div><label style={lbl}>거치 개월</label><input style={inp} type="number" placeholder="12" value={form.graceMonths} onChange={e=>setForm(f=>({...f,graceMonths:e.target.value}))}/></div>
            <div><label style={lbl}>상환 개월</label><input style={inp} type="number" placeholder="48" value={form.repayMonths} onChange={e=>setForm(f=>({...f,repayMonths:e.target.value}))}/></div>
          </>}
          <div style={{ gridColumn:"1/-1" }}><label style={lbl}>⚠️ 경고 메시지 (선택)</label><input style={inp} placeholder="예: 만기연장 필요" value={form.warning||""} onChange={e=>setForm(f=>({...f,warning:e.target.value}))}/></div>
        </div>
        <div style={{ marginBottom:20 }}>
          <label style={lbl}>색상</label>
          <div style={{ display:"flex",gap:7,flexWrap:"wrap" }}>
            {COLORS.map(c=><div key={c} onClick={()=>setForm(f=>({...f,color:c}))} style={{ width:26,height:26,borderRadius:6,background:c,cursor:"pointer",border:form.color===c?"3px solid "+T.text:"3px solid transparent" }}/>)}
          </div>
        </div>
        <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer",color:T.sub }}>취소</button>
          <button onClick={()=>{
            if(!form.name||!form.balance) return alert("대출명과 잔액을 입력해주세요!");
            onSave({
              ...form,
              id: loan?.id||Date.now(),
              balance: Number(form.balance),
              rate: Number(form.rate)||0,
              payDay: Number(form.payDay)||15,
              totalMonths: Number(form.totalMonths)||0,
              graceMonths: Number(form.graceMonths)||0,
              repayMonths: Number(form.repayMonths)||0,
            });
          }} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ─── 고정비 모달 ──────────────────────────────────────────────
function CostModal({ T, onSave, onClose }) {
  const COLORS = ["#10B981","#3B82F6","#F59E0B","#8B5CF6","#EC4899","#EF4444","#F97316","#14B8A6"];
  const [form, setForm] = useState({ name:"",payDay:"",amount:"",category:"기타" });
  const [color, setColor] = useState(COLORS[0]);
  const inp = { width:"100%", background:T.inp, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 12px", color:T.text, fontSize:13, boxSizing:"border-box", fontFamily:"inherit" };
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:24,width:"min(400px,95vw)" }}>
        <div style={{ fontSize:16,fontWeight:900,color:T.text,marginBottom:16 }}>🏢 고정비 항목 추가</div>
        <div style={{ marginBottom:12 }}><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>항목명</div><input style={inp} placeholder="예: 사무실 임대료" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
          <div><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>납부일</div><input style={inp} type="number" min="1" max="31" placeholder="5" value={form.payDay} onChange={e=>setForm(f=>({...f,payDay:e.target.value}))}/></div>
          <div><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>금액 (원)</div><input style={inp} type="number" placeholder="500000" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))}/></div>
        </div>
        <div style={{ marginBottom:14 }}><div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:5 }}>카테고리</div>
          <select style={inp} value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
            {["임차료","인건비","통신비","보험료","지급수수료","운반비","수도광열비","기타"].map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,color:T.muted,fontWeight:700,marginBottom:8 }}>색상</div>
          <div style={{ display:"flex",gap:7 }}>
            {COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{ width:26,height:26,borderRadius:6,background:c,cursor:"pointer",border:color===c?"3px solid "+T.text:"3px solid transparent" }}/>)}
          </div>
        </div>
        <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer",color:T.sub }}>취소</button>
          <button onClick={()=>{if(!form.name||!form.payDay||!form.amount)return alert("모두 입력해주세요!");onSave({id:Date.now(),name:form.name,payDay:Number(form.payDay),amount:Number(form.amount),color,category:form.category});}} style={{ background:T.ok,color:"#fff",border:"none",borderRadius:8,padding:"10px 18px",fontSize:13,fontWeight:700,cursor:"pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ─── 메인 앱 ─────────────────────────────────────────────────
function FinanceApp({ user }) {
  const [dark, setDark] = useState(true);
  const T = dark ? DARK : LIGHT;
  const numFont = { fontFamily:"'DM Mono',monospace" };

  const [tab, setTab]         = useState("캘린더");
  const [cards, setCards]     = useState(DEFAULT_CARDS);
  const [loans, setLoans]     = useState(DEFAULT_LOANS);
  const [costs, setCosts]     = useState(DEFAULT_COSTS);
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [memos, setMemos]     = useState({});
  const [saving, setSaving]   = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  const [calYear, setCalYear]       = useState(TODAY.getFullYear());
  const [calMonth, setCalMonth]     = useState(TODAY.getMonth());
  const [weekStart, setWeekStart]   = useState(1);
  const [selectedDay, setSelectedDay] = useState(null);
  const [filter, setFilter]         = useState({ card:true, loan:true, cost:true, memo:true });
  const [ledgerOpen, setLedgerOpen] = useState(true);
  const [showMemoModal, setShowMemoModal] = useState(false);
  const [showCardModal, setShowCardModal] = useState(false);
  const [showCostModal, setShowCostModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editCard, setEditCard]     = useState(null);
  const [editAccount, setEditAccount] = useState(null);
  const [showLoanModal, setShowLoanModal] = useState(false);
  const [editLoan, setEditLoan]       = useState(null);

  // ── Firebase 데이터 로드 ──
  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDoc(doc(db, "users", user.uid, "data", "settings"));
        const isOwner = user.uid === OWNER_UID;
        if (snap.exists()) {
          const d = snap.data();
          const loadedCards = d.cards || (isOwner ? OWNER_CARDS : DEFAULT_CARDS);
          const loadedLoans = d.loans || (isOwner ? OWNER_LOANS : DEFAULT_LOANS);
          setCards(loadedCards);
          if (d.costs)    setCosts(d.costs);
          if (d.accounts) setAccounts(d.accounts);
          setLoans(loadedLoans);
          if (d.dark !== undefined) setDark(d.dark);
          // cards나 loans가 없었으면 바로 Firebase에 저장
          if (!d.cards || !d.loans) {
            await setDoc(doc(db, "users", user.uid, "data", "settings"), {
              ...d, cards:loadedCards, loans:loadedLoans
            }, { merge:true });
          }
        } else if (isOwner) {
          setCards(OWNER_CARDS);
          setLoans(OWNER_LOANS);
        }
        const memoSnap = await getDoc(doc(db, "users", user.uid, "data", "memos"));
        if (memoSnap.exists()) setMemos(memoSnap.data().entries || {});
      } catch(e) { console.error(e); }
      setLoadingData(false);
    };
    load();
  }, [user.uid]);

  // ── Firebase 저장 ──
  const saveToFirebase = useCallback(async (newCards, newCosts, newDark, newAccounts, newLoans) => {
    setSaving(true);
    try {
      await setDoc(doc(db, "users", user.uid, "data", "settings"), { cards:newCards, costs:newCosts, dark:newDark, accounts:newAccounts, loans:newLoans });
    } catch(e) { console.error(e); }
    setSaving(false);
  }, [user.uid]);

  const saveMemos = useCallback(async (newMemos) => {
    try { await setDoc(doc(db,"users",user.uid,"data","memos"),{ entries:newMemos }); }
    catch(e) { console.error(e); }
  }, [user.uid]);

  const updateCards = (fn) => {
    setCards(prev => { const n = typeof fn==="function"?fn(prev):fn; saveToFirebase(n,costs,dark,accounts,loans); return n; });
  };
  const updateCosts = (fn) => {
    setCosts(prev => { const n = typeof fn==="function"?fn(prev):fn; saveToFirebase(cards,n,dark,accounts,loans); return n; });
  };
  const updateAccounts = (fn) => {
    setAccounts(prev => { const n = typeof fn==="function"?fn(prev):fn; saveToFirebase(cards,costs,dark,n,loans); return n; });
  };
  const toggleDark = () => { const nd=!dark; setDark(nd); saveToFirebase(cards,costs,nd,accounts,loans); };
  const updateLoans = (fn) => {
    setLoans(prev => { const n = typeof fn==="function"?fn(prev):fn; saveToFirebase(cards,costs,dark,accounts,n); return n; });
  };

  const loansWS = useMemo(() => loans.map(getLoanWithSchedule), [loans]);
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();

  // ── 캘린더 이벤트 빌드 ──
  const calEvents = useMemo(() => {
    const map = {};
    const add = (day, ev) => { if(day>=1&&day<=daysInMonth){if(!map[day])map[day]=[];map[day].push(ev);} };

    if (filter.card) cards.forEach(c => {
      const day = adjustToWeekday(calYear, calMonth, Math.min(c.payDay, daysInMonth), daysInMonth);
      add(day, { type:"card", color:c.color, icon:"💳", label:c.company, amount:c.billing, detail:`결제 ₩${fmt(c.billing)} · 한도 ₩${fmt(c.limit)}` });
    });

    if (filter.loan) loansWS.forEach(loan => {
      (loan.schedule||[]).forEach(s => {
        const [y,m,d] = s.date.split("-").map(Number);
        if (y===calYear && m===calMonth+1 && d>=1 && d<=daysInMonth)
          add(d, { type:s.principal>0?"loan":"interest", color:loan.color, icon:s.principal>0?"🏦":"💸",
            label:loan.name.length>9?loan.name.slice(0,9)+"…":loan.name, fullLabel:loan.name,
            amount:s.total, principal:s.principal, interest:s.interest, balance:s.balance,
            detail:s.principal>0?`원금 ₩${fmt(s.principal)} + 이자 ₩${fmt(s.interest)}`:`이자만 ₩${fmt(s.interest)}` });
      });
    });

    if (filter.cost) costs.forEach(c => {
      const day = adjustToWeekday(calYear, calMonth, Math.min(c.payDay, daysInMonth), daysInMonth);
      add(day, { type:"cost", color:c.color, icon:"🏢", label:c.name, amount:c.amount, detail:`${c.category} · ₩${fmt(c.amount)}` });
    });

    if (filter.memo) Object.entries(memos).forEach(([dateStr, entries]) => {
      const [y,m,d] = dateStr.split("-").map(Number);
      if (y===calYear && m===calMonth+1 && d>=1 && d<=daysInMonth)
        entries.forEach(e => add(d, { ...e, type:"memo", detail:`${e.type} · ₩${fmt(e.amount)}` }));
    });

    return map;
  }, [cards, loansWS, costs, memos, calYear, calMonth, filter, daysInMonth]);

  // ── 월 합계 ──
  const monthTotal = useMemo(() => {
    let card=0, loan=0, cost=0, income=0, expense=0;
    Object.values(calEvents).flat().forEach(e => {
      if (e.type==="card")    card    += e.amount;
      else if (e.type==="loan"||e.type==="interest") loan += e.amount;
      else if (e.type==="cost")   cost    += e.amount;
      else if (e.type==="memo") {
        if (e.type2==="수입"||e.type==="memo"&&e.icon==="💚") income += e.amount;
        else expense += e.amount;
      }
    });
    // re-calc memos separately
    let memoIncome=0, memoExpense=0;
    Object.entries(memos).forEach(([dateStr, entries]) => {
      const [y,m] = dateStr.split("-").map(Number);
      if (y===calYear && m===calMonth+1) entries.forEach(e => {
        if (e.type==="수입") memoIncome+=e.amount; else memoExpense+=e.amount;
      });
    });
    return { card, loan, cost, memoIncome, memoExpense, total:card+loan+cost+memoExpense };
  }, [calEvents, memos, calYear, calMonth]);

  // ── 가계부 데이터 (달력 하단 테이블용) ──
  const ledgerRows = useMemo(() => {
    const rows = [];
    for (let d=1; d<=daysInMonth; d++) {
      const evs = calEvents[d]||[];
      evs.forEach(ev => {
        const acct = ev.accountId ? accounts.find(a=>a.id===ev.accountId) : null;
        rows.push({
          day: d,
          label: ev.fullLabel||ev.label,
          income:  ev.type==="memo"&&ev.icon==="💚" ? ev.amount : 0,
          expense: ev.type==="memo"&&ev.icon==="💚" ? 0 : ev.amount,
          color: ev.color,
          icon: ev.icon,
          type: ev.type,
          accountName: acct?.name||"",
        });
      });
    }
    rows.sort((a,b)=>a.day-b.day);
    // 잔액 = 전체 계좌 합산 잔액에서 시작
    const startBal = accounts.reduce((s,a)=>s+a.balance,0);
    let bal = startBal;
    return rows.map(r => { bal += r.income - r.expense; return { ...r, balance:bal }; });
  }, [calEvents, daysInMonth, accounts]);

  // ── 캘린더 그리드 ──
  const { firstDay } = useMemo(() => ({
    firstDay: (new Date(calYear,calMonth,1).getDay() - weekStart + 7) % 7
  }), [calYear, calMonth, weekStart]);

  const WEEKDAYS = weekStart===1 ? ["월","화","수","목","금","토","일"] : ["일","월","화","수","목","금","토"];
  const isToday  = d => TODAY.getFullYear()===calYear && TODAY.getMonth()===calMonth && TODAY.getDate()===d;
  const getDow   = d => new Date(calYear, calMonth, d).getDay();

  const totalDebt     = loans.reduce((s,l)=>s+l.balance,0);
  const totalCardBill = cards.reduce((s,c)=>s+c.billing,0);

  const TABS = ["캘린더","대시보드","카드 관리","대출 관리","고정비 관리","계좌 관리"];

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
    *{box-sizing:border-box;margin:0;padding:0;}
    ::-webkit-scrollbar{width:5px;height:5px;}
    ::-webkit-scrollbar-track{background:${T.bg};}
    ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
    input,select,button{font-family:inherit;outline:none;}
    @keyframes fu{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
    .fu{animation:fu 0.3s ease forwards;}
    .dc:hover{opacity:0.85;cursor:pointer;}
  `;

  if (loadingData) return (
    <div style={{ minHeight:"100vh",background:T.bg,display:"flex",alignItems:"center",justifyContent:"center",color:T.muted,fontFamily:"'Noto Sans KR',sans-serif",fontSize:16 }}>
      <style>{css}</style>🔄 데이터 불러오는 중...
    </div>
  );

  return (
    <div style={{ fontFamily:"'Noto Sans KR',sans-serif",background:T.bg,minHeight:"100vh",color:T.text }}>
      <style>{css}</style>

      {showMemoModal && selectedDay && (
        <MemoModal date={`${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(selectedDay).padStart(2,"0")}`} T={T} accounts={accounts}
          onSave={memo => {
            const key = memo.date;
            const nm = { ...memos, [key]: [...(memos[key]||[]), memo] };
            setMemos(nm); saveMemos(nm); setShowMemoModal(false);
          }} onClose={()=>setShowMemoModal(false)}/>
      )}
      {(showAccountModal||editAccount) && (
        <AccountModal account={editAccount} T={T}
          onSave={a=>{ if(editAccount) updateAccounts(p=>p.map(x=>x.id===a.id?a:x)); else updateAccounts(p=>[...p,a]); setShowAccountModal(false);setEditAccount(null); }}
          onClose={()=>{setShowAccountModal(false);setEditAccount(null);}}/>
      )}
      {(showCardModal||editCard) && (
        <CardModal card={editCard} T={T}
          onSave={c=>{ if(editCard) updateCards(p=>p.map(x=>x.id===c.id?c:x)); else updateCards(p=>[...p,c]); setShowCardModal(false);setEditCard(null); }}
          onClose={()=>{setShowCardModal(false);setEditCard(null);}}/>
      )}
      {showCostModal && <CostModal T={T} onSave={c=>{updateCosts(p=>[...p,c]);setShowCostModal(false);}} onClose={()=>setShowCostModal(false)}/>}
      {(showLoanModal||editLoan) && (
        <LoanModal loan={editLoan} T={T}
          onSave={l=>{
            if(editLoan) updateLoans(p=>p.map(x=>x.id===l.id?l:x));
            else updateLoans(p=>[...p,l]);
            setShowLoanModal(false); setEditLoan(null);
          }}
          onClose={()=>{setShowLoanModal(false);setEditLoan(null);}}/>
      )}

      {/* ─── 헤더 ─── */}
      <div style={{ background:T.hdr,borderBottom:`1px solid ${T.border}`,padding:"13px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:50,backdropFilter:"blur(12px)" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>💰</div>
          <div>
            <div style={{ fontSize:16,fontWeight:900,color:dark?"#F8FAFC":T.bg2 }}>통합 재무 캘린더</div>
            <div style={{ fontSize:10,color:dark?"#475569":"#8AAAC8",marginTop:1 }}>카드 · 대출 · 고정비</div>
          </div>
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          {saving && <span style={{ fontSize:11,color:T.warn }}>💾 저장 중...</span>}
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:10,color:dark?"#475569":"#8AAAC8" }}>이번달 지출</div>
            <div style={{ fontSize:14,fontWeight:900,color:T.danger,...numFont }}>₩{fmt(monthTotal.total)}</div>
          </div>
          {/* 다크/라이트 모드 토글 */}
          <button onClick={toggleDark} style={{ background:dark?"#1E2D4A":"#E8EFF8",border:`1px solid ${T.border}`,borderRadius:20,padding:"6px 14px",cursor:"pointer",fontSize:13,color:T.text,display:"flex",alignItems:"center",gap:6,fontWeight:600 }}>
            {dark ? "☀️ 라이트" : "🌙 다크"}
          </button>
          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:dark?"#0F1629":"#fff",border:`1px solid ${T.border}`,borderRadius:20 }}>
            <div style={{ width:24,height:24,borderRadius:"50%",background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:700 }}>{user.displayName?.[0]?.toUpperCase()||"U"}</div>
            <span style={{ fontSize:12,color:T.sub }}>{user.displayName||user.email?.split("@")[0]}</span>
            <button onClick={()=>signOut(auth)} style={{ background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.muted }}>로그아웃</button>
          </div>
        </div>
      </div>

      {/* ─── 탭 ─── */}
      <div style={{ display:"flex",gap:3,padding:"8px 16px",background:dark?"#090D1F":T.bg3,borderBottom:`1px solid ${T.border}`,overflowX:"auto" }}>
        {TABS.map(t=>(
          <button key={t} onClick={()=>{setTab(t);setSelectedDay(null);}} style={{ padding:"7px 14px",borderRadius:8,fontSize:15,fontWeight:700,cursor:"pointer",border:"none",background:tab===t?T.acc:"transparent",color:tab===t?"#fff":T.sub,whiteSpace:"nowrap",transition:"all 0.15s" }}>{t}</button>
        ))}
      </div>

      <div style={{ padding:"14px 16px",maxWidth:1600,margin:"0 auto" }}>

        {/* ══════════════════ 캘린더 탭 ══════════════════ */}
        {tab==="캘린더" && (
          <div className="fu">
            {/* 컨트롤 바 */}
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8 }}>
              <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                {["‹","›"].map((a,i)=>(
                  <button key={a} onClick={()=>{const nd=new Date(calYear,calMonth+(i?1:-1));setCalYear(nd.getFullYear());setCalMonth(nd.getMonth());setSelectedDay(null);}} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8,color:T.sub,padding:"7px 15px",cursor:"pointer",fontSize:15 }}>{a}</button>
                ))}
                <span style={{ fontSize:15,fontWeight:900,color:T.text,...numFont }}>{calYear}년 {calMonth+1}월</span>
                <button onClick={()=>{setCalYear(TODAY.getFullYear());setCalMonth(TODAY.getMonth());}} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:6,color:T.muted,padding:"5px 10px",cursor:"pointer",fontSize:15 }}>오늘</button>
              </div>
              <div style={{ display:"flex",gap:5,flexWrap:"wrap",alignItems:"center" }}>
                {[{k:"card",l:"💳 카드",c:T.acc},{k:"loan",l:"🏦 대출",c:"#A78BFA"},{k:"cost",l:"🏢 고정비",c:T.warn},{k:"memo",l:"✏️ 메모",c:T.ok}].map(f=>(
                  <button key={f.k} onClick={()=>setFilter(p=>({...p,[f.k]:!p[f.k]}))} style={{ padding:"5px 11px",borderRadius:20,fontSize:15,fontWeight:700,cursor:"pointer",border:`1px solid ${filter[f.k]?f.c+"66":T.border}`,background:filter[f.k]?f.c+"22":"transparent",color:filter[f.k]?f.c:T.muted,transition:"all 0.15s" }}>{f.l}</button>
                ))}
                <div style={{ display:"flex",background:T.bg2,borderRadius:8,border:`1px solid ${T.border}`,overflow:"hidden" }}>
                  {[["월",1],["일",0]].map(([l,v])=>(
                    <button key={v} onClick={()=>setWeekStart(v)} style={{ padding:"5px 11px",fontSize:15,cursor:"pointer",border:"none",background:weekStart===v?T.acc:"transparent",color:weekStart===v?"#fff":T.sub,fontWeight:700 }}>{l}요일</button>
                  ))}
                </div>
              </div>
            </div>

            {/* 월 합계 */}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12 }}>
              {[
                {l:"💳 카드",   v:monthTotal.card,      c:T.acc},
                {l:"🏦 대출",   v:monthTotal.loan,      c:"#A78BFA"},
                {l:"🏢 고정비", v:monthTotal.cost,      c:T.warn},
                {l:"📊 총 지출",v:monthTotal.total,     c:T.danger},
              ].map(s=>(
                <div key={s.l} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 12px" }}>
                  <div style={{ fontSize:13,color:T.muted,marginBottom:4 }}>{s.l}</div>
                  <div style={{ fontSize:16,fontWeight:400,color:s.c,...numFont }}>₩{fmt(s.v)}</div>
                </div>
              ))}
            </div>

            {/* 캘린더 + 사이드 패널 래퍼 */}
            <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
              {/* 캘린더 본체 */}
              <div style={{ flex:1,minWidth:0 }}>
                {/* 요일 헤더 */}
                <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:2 }}>
                  {WEEKDAYS.map((d,i)=>{
                    const isSun=(weekStart===1&&i===6)||(weekStart===0&&i===0);
                    const isSat=(weekStart===1&&i===5)||(weekStart===0&&i===6);
                    return <div key={d} style={{ textAlign:"center",padding:"7px 0",fontSize:15,fontWeight:700,color:isSun?T.danger:isSat?T.warn:T.muted }}>{d}</div>;
                  })}
                </div>

                {/* 날짜 그리드 */}
                <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2 }}>
                  {Array.from({length:firstDay},(_,i)=><div key={"e"+i}/>)}
                  {Array.from({length:daysInMonth},(_,i)=>{
                    const d = i+1;
                    const evs = calEvents[d]||[];
                    const isTod = isToday(d);
                    const dow = getDow(d);
                    const isSun=dow===0, isSat=dow===6;
                    const isSel = selectedDay===d;
                    const hasMemo = evs.some(e=>e.type==="memo");
                    return (
                      <div key={d} onClick={()=>setSelectedDay(isSel?null:d)} style={{
                        minHeight:164,padding:"5px 5px 4px",borderRadius:7,cursor:"pointer",
                        background:isTod?(dark?"#141D35":"#EFF6FF"):isSel?(dark?"#0D1A2E":"#F0F7FF"):isSun?(dark?"#18080A":"#FFF5F5"):isSat?(dark?"#180F00":"#FFFBF0"):T.bg2,
                        border:`1.5px solid ${isTod?T.acc:isSel?T.border2:isSun?(dark?"#3B0A0A":"#FDD"):isSat?(dark?"#3B2200":"#FFE"):(T.border)}`,
                        transition:"all 0.12s",position:"relative"
                      }}>
                        <div style={{ fontSize:15,fontWeight:isTod?800:400,marginBottom:3,color:isTod?T.acc:isSun?T.danger:isSat?T.warn:T.muted }}>
                          {isTod ? <span style={{ background:T.acc,color:"#fff",borderRadius:4,padding:"1px 5px",fontSize:15 }}>오늘</span> : d}
                          {hasMemo && <span style={{ marginLeft:3,fontSize:13,color:T.ok }}>✎</span>}
                        </div>
                        {evs.slice(0,3).map((ev,ei)=>(
                          <div key={ei} style={{ fontSize:13,padding:"2px 4px",borderRadius:3,marginBottom:2,background:ev.color+"28",border:`1px solid ${ev.color}55`,color:ev.color,lineHeight:1.4,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis" }}>
                            {ev.icon} {ev.label}
                          </div>
                        ))}
                        {evs.length>3 && <div style={{ fontSize:13,color:T.muted,paddingLeft:2 }}>+{evs.length-3}건</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 오른쪽 사이드 패널 */}
              <div style={{ width:300,flexShrink:0,position:"sticky",top:80 }}>
                {selectedDay ? (
                  <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:16 }}>
                    <div style={{ marginBottom:12 }}>
                      <div style={{ fontSize:15,fontWeight:800,color:T.text }}>
                        {calYear}년 {calMonth+1}월 {selectedDay}일
                        {getDow(selectedDay)===6&&<span style={{ fontSize:11,color:T.warn,marginLeft:6 }}>토</span>}
                        {getDow(selectedDay)===0&&<span style={{ fontSize:11,color:T.danger,marginLeft:6 }}>일</span>}
                      </div>
                      {(calEvents[selectedDay]||[]).length>0 && (
                        <div style={{ ...numFont,fontSize:12,color:T.danger,marginTop:4 }}>
                          지출 ₩{fmt((calEvents[selectedDay]||[]).filter(e=>!(e.type==="memo"&&e.icon==="💚")).reduce((s,e)=>s+e.amount,0))}
                        </div>
                      )}
                    </div>
                    <button onClick={()=>setShowMemoModal(true)} style={{ width:"100%",background:T.ok,color:"#fff",border:"none",borderRadius:8,padding:"8px",fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:12 }}>+ 수입/지출 추가</button>
                    {(calEvents[selectedDay]||[]).length===0 && <div style={{ textAlign:"center",color:T.muted,fontSize:12,padding:"16px 0" }}>이 날 일정이 없습니다.</div>}
                    <div style={{ display:"flex",flexDirection:"column",gap:6,maxHeight:500,overflowY:"auto" }}>
                      {(calEvents[selectedDay]||[]).map((ev,i)=>(
                        <div key={i} style={{ padding:"10px 12px",background:dark?"#070B18":T.bg3,borderRadius:10,borderLeft:`4px solid ${ev.color}` }}>
                          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
                            <div style={{ flex:1,minWidth:0 }}>
                              <div style={{ fontSize:12,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ev.icon} {ev.fullLabel||ev.label}</div>
                              <div style={{ fontSize:11,color:T.muted,marginTop:2 }}>{ev.detail}</div>
                              {ev.balance!==undefined&&ev.type!=="memo"&&<div style={{ fontSize:10,color:T.muted,marginTop:1,...numFont }}>잔액 ₩{fmt(ev.balance)}</div>}
                            </div>
                            <div style={{ display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,marginLeft:8 }}>
                              <div style={{ fontSize:13,fontWeight:900,color:ev.type==="memo"&&ev.icon==="💚"?T.ok:ev.color,...numFont }}>
                                {ev.type==="memo"&&ev.icon==="💚"?"+":"-"}₩{fmt(ev.amount)}
                              </div>
                              {ev.type==="memo"&&(
                                <button onClick={()=>{
                                  const key=`${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(selectedDay).padStart(2,"0")}`;
                                  const nm={...memos,[key]:(memos[key]||[]).filter(m=>m.id!==ev.id)};
                                  if(!nm[key].length) delete nm[key];
                                  setMemos(nm); saveMemos(nm);
                                }} style={{ background:"none",border:`1px solid ${T.danger}`,borderRadius:5,padding:"2px 6px",fontSize:10,color:T.danger,cursor:"pointer" }}>삭제</button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:20,textAlign:"center",color:T.muted,fontSize:13 }}>
                    날짜를 클릭하면<br/>상세 내역이 표시됩니다
                  </div>
                )}
              </div>
            </div>

            {/* ─── 달력 하단 가계부 테이블 ─── */}
            <div style={{ marginTop:14,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden" }}>
              <div onClick={()=>setLedgerOpen(p=>!p)} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 18px",cursor:"pointer",background:dark?"#0A0E20":T.bg3,borderBottom:ledgerOpen?`1px solid ${T.border}`:"none" }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <span style={{ fontSize:15,fontWeight:800,color:T.text }}>📋 {calYear}년 {calMonth+1}월 가계부</span>
                  <span style={{ fontSize:12,color:T.muted }}>{ledgerRows.length}건</span>
                </div>
                <div style={{ display:"flex",alignItems:"center",gap:16 }}>
                  <div style={{ fontSize:12,color:T.ok,...numFont }}>수입 ₩{fmt(monthTotal.memoIncome)}</div>
                  <div style={{ fontSize:12,color:T.danger,...numFont }}>지출 ₩{fmt(monthTotal.total)}</div>
                  <span style={{ color:T.muted,fontSize:16,transition:"transform 0.2s",transform:ledgerOpen?"rotate(0)":"rotate(-90deg)",display:"inline-block" }}>▾</span>
                </div>
              </div>
              {ledgerOpen && (
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%",borderCollapse:"collapse",fontSize:14 }}>
                    <thead>
                      <tr style={{ background:dark?"#090D1F":T.bg3 }}>
                        {["월","일","항목","계좌","입금","출금","잔액"].map(h=>(
                          <th key={h} style={{ padding:"9px 12px",textAlign:["입금","출금","잔액"].includes(h)?"right":"left",color:T.muted,fontSize:10,fontWeight:700,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerRows.length===0 && (
                        <tr><td colSpan={7} style={{ padding:"24px",textAlign:"center",color:T.muted,fontSize:13 }}>이번 달 일정이 없습니다</td></tr>
                      )}
                      {ledgerRows.map((r,i)=>(
                        <tr key={i} style={{ background:i%2===0?T.ledgerRow:T.ledgerAlt,borderBottom:`1px solid ${T.border}` }}>
                          <td style={{ padding:"8px 12px",color:T.muted,...numFont }}>{calMonth+1}</td>
                          <td style={{ padding:"8px 12px",color:T.muted,...numFont,fontWeight:400 }}>{r.day}</td>
                          <td style={{ padding:"8px 12px" }}>
                            <span style={{ display:"inline-flex",alignItems:"center",gap:6 }}>
                              <span style={{ width:8,height:8,borderRadius:2,background:r.color,flexShrink:0,display:"inline-block" }}/>
                              <span style={{ color:T.text,fontWeight:600 }}>{r.label}</span>
                              <span style={{ fontSize:10,color:T.muted,background:r.type==="card"?(dark?"#1E2D4A":T.bg3):r.type==="loan"||r.type==="interest"?"#2D1A4A":"#1A2D1A",padding:"1px 5px",borderRadius:4 }}>
                                {r.type==="card"?"카드":r.type==="loan"?"대출원리금":r.type==="interest"?"이자":r.type==="cost"?"고정비":"메모"}
                              </span>
                            </span>
                          </td>
                          <td style={{ padding:"8px 12px",color:T.sub,fontSize:11 }}>{r.accountName||"—"}</td>
                          <td style={{ padding:"8px 12px",textAlign:"right",color:T.ok,fontWeight:400,...numFont }}>
                            {r.income>0 ? fmt(r.income) : ""}
                          </td>
                          <td style={{ padding:"8px 12px",textAlign:"right",color:T.danger,fontWeight:400,...numFont }}>
                            {r.expense>0 ? fmt(r.expense) : ""}
                          </td>
                          <td style={{ padding:"8px 12px",textAlign:"right",color:r.balance>=0?T.ok:T.danger,fontWeight:400,...numFont }}>
                            {fmt(Math.abs(r.balance))}{r.balance<0?" (-)":""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background:dark?"#090D1F":T.bg3,borderTop:`2px solid ${T.border}` }}>
                        <td colSpan={4} style={{ padding:"10px 12px",fontWeight:800,color:T.text,fontSize:13 }}>합계</td>
                        <td style={{ padding:"10px 12px",textAlign:"right",color:T.ok,fontWeight:400,...numFont }}>
                          {fmt(ledgerRows.reduce((s,r)=>s+r.income,0))}
                        </td>
                        <td style={{ padding:"10px 12px",textAlign:"right",color:T.danger,fontWeight:400,...numFont }}>
                          {fmt(ledgerRows.reduce((s,r)=>s+r.expense,0))}
                        </td>
                        <td style={{ padding:"10px 12px",textAlign:"right",color:T.muted,...numFont }}>—</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════ 대시보드 탭 ══════════════════ */}
        {tab==="대시보드" && (
          <div className="fu">
            <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14 }}>
              {[
                {l:"총 대출 잔액",    v:fmtM(totalDebt)+"원",        c:T.danger},
                {l:"💳 이번달 카드",  v:"₩"+fmt(totalCardBill),      c:T.acc},
                {l:"🏦 이번달 대출",  v:"₩"+fmt(monthTotal.loan),    c:"#A78BFA"},
                {l:"🏢 월 고정비",    v:"₩"+fmt(costs.reduce((s,c)=>s+c.amount,0)), c:T.warn},
              ].map((s,i)=>(
                <div key={i} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px" }}>
                  <div style={{ fontSize:10,color:T.muted,fontWeight:700,marginBottom:7 }}>{s.l}</div>
                  <div style={{ fontSize:17,fontWeight:900,color:s.c,...numFont }}>{s.v}</div>
                </div>
              ))}
            </div>
            {loans.filter(l=>l.warning).map(l=>(
              <div key={l.id} style={{ background:dark?"#1C0A0A":"#FFF5F5",border:`1px solid ${T.danger}44`,borderRadius:12,padding:"13px 16px",display:"flex",gap:10,marginBottom:10 }}>
                <span style={{ fontSize:20 }}>🚨</span>
                <div><div style={{ color:T.danger,fontWeight:800 }}>{l.name} — 만기 {l.maturity}</div><div style={{ color:T.danger,fontSize:12,marginTop:3 }}>{l.warning}</div></div>
              </div>
            ))}
            <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:16,marginBottom:12 }}>
              <div style={{ fontSize:13,fontWeight:800,color:T.text,marginBottom:12 }}>{calYear}년 {calMonth+1}월 지출 구성</div>
              {[
                {l:"💳 카드 결제",  v:monthTotal.card, c:T.acc},
                {l:"🏦 대출 납부",  v:monthTotal.loan, c:"#A78BFA"},
                {l:"🏢 사업 고정비",v:monthTotal.cost, c:T.warn},
              ].map(item=>(
                <div key={item.l} style={{ marginBottom:10 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                    <span style={{ fontSize:12,color:T.sub }}>{item.l}</span>
                    <span style={{ fontSize:12,fontWeight:700,color:item.c,...numFont }}>₩{fmt(item.v)} ({monthTotal.total?((item.v/monthTotal.total)*100).toFixed(1):0}%)</span>
                  </div>
                  <div style={{ background:T.border,borderRadius:3,height:6 }}>
                    <div style={{ background:item.c,height:6,borderRadius:3,width:`${monthTotal.total?(item.v/monthTotal.total)*100:0}%`,transition:"width 0.6s" }}/>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:16 }}>
              <div style={{ fontSize:13,fontWeight:800,color:T.text,marginBottom:12 }}>💳 카드 한도 소진 현황</div>
              {cards.map(c=>(
                <div key={c.id} style={{ marginBottom:10 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                    <span style={{ fontSize:12,color:T.sub }}>{c.company} <span style={{ color:T.muted }}>결제일 {c.payDay}일</span></span>
                    <span style={{ fontSize:12,color:c.color,...numFont }}>₩{fmt(c.billing)} / ₩{fmt(c.limit)}</span>
                  </div>
                  <div style={{ background:T.border,borderRadius:3,height:6 }}>
                    <div style={{ background:c.color,height:6,borderRadius:3,width:`${Math.min(100,(c.billing/c.limit)*100)}%` }}/>
                  </div>
                  <div style={{ fontSize:10,color:T.muted,marginTop:2,...numFont }}>가용 ₩{fmt(c.limit-c.billing)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════════════ 카드 관리 탭 ══════════════════ */}
        {tab==="카드 관리" && (
          <div className="fu">
            <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14 }}>
              {[
                {l:"카드 총 한도",   v:"₩"+fmt(cards.reduce((s,c)=>s+c.limit,0)),                            c:T.acc},
                {l:"이번 달 청구",   v:"₩"+fmt(totalCardBill),                                               c:T.warn},
                {l:"총 가용 한도",   v:"₩"+fmt(cards.reduce((s,c)=>s+c.limit,0)-totalCardBill),              c:T.ok},
              ].map((s,i)=>(
                <div key={i} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px" }}>
                  <div style={{ fontSize:10,color:T.muted,marginBottom:6 }}>{s.l}</div>
                  <div style={{ fontSize:18,fontWeight:900,color:s.c,...numFont }}>{s.v}</div>
                </div>
              ))}
            </div>
            {cards.map(c=>(
              <div key={c.id} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderLeft:`4px solid ${c.color}`,borderRadius:12,padding:14,marginBottom:8 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:800,fontSize:15,color:T.text }}>{c.company}</div>
                    <div style={{ fontSize:12,color:T.muted,marginTop:2,...numFont }}>결제일 {c.payDay}일 · 한도 ₩{fmt(c.limit)}</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                    <div style={{ textAlign:"right" }}><div style={{ fontWeight:900,fontSize:16,color:T.warn,...numFont }}>₩{fmt(c.billing)}</div><div style={{ fontSize:10,color:T.muted }}>이번 달 청구</div></div>
                    <button onClick={()=>setEditCard(c)} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>수정</button>
                    <button onClick={()=>{if(window.confirm("삭제?"))updateCards(p=>p.filter(x=>x.id!==c.id));}} style={{ background:T.danger,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>삭제</button>
                  </div>
                </div>
                <div style={{ marginTop:10,background:T.border,borderRadius:3,height:5 }}>
                  <div style={{ background:c.color,height:5,borderRadius:3,width:`${Math.min(100,(c.billing/c.limit)*100)}%` }}/>
                </div>
              </div>
            ))}
            <button onClick={()=>setShowCardModal(true)} style={{ width:"100%",padding:"12px",background:"none",border:`1.5px dashed ${T.border2}`,borderRadius:12,cursor:"pointer",fontSize:13,color:T.acc,fontWeight:700 }}>+ 카드 추가</button>
          </div>
        )}

        {/* ══════════════════ 대출 관리 탭 ══════════════════ */}
        {tab==="대출 관리" && (
          <div className="fu">
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,flex:1,marginRight:12 }}>
                {[
                  {l:"총 대출 잔액",    v:fmtM(totalDebt)+"원",      c:T.danger},
                  {l:"이번달 납부 예정",v:"₩"+fmt(monthTotal.loan),  c:"#A78BFA"},
                ].map((s,i)=>(
                  <div key={i} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px" }}>
                    <div style={{ fontSize:10,color:T.muted,marginBottom:6 }}>{s.l}</div>
                    <div style={{ fontSize:20,fontWeight:900,color:s.c,...numFont }}>{s.v}</div>
                  </div>
                ))}
              </div>
              <button onClick={()=>setShowLoanModal(true)} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:8,padding:"10px 16px",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap" }}>+ 대출 추가</button>
            </div>
            {loans.filter(l=>l.warning).map(l=>(
              <div key={l.id} style={{ background:dark?"#1C0A0A":"#FFF5F5",border:`1px solid ${T.danger}44`,borderRadius:12,padding:"13px 16px",display:"flex",gap:10,marginBottom:10 }}>
                <span>🚨</span>
                <div><div style={{ color:T.danger,fontWeight:800 }}>{l.name} — 만기 {l.maturity}</div><div style={{ color:T.danger,fontSize:12,marginTop:3 }}>{l.warning}</div></div>
              </div>
            ))}
            {loansWS.map(loan=>{
              const upcoming=(loan.schedule||[]).filter(s=>s.date>=TODAY_STR).slice(0,3);
              return (
                <div key={loan.id} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderLeft:`4px solid ${loan.color}`,borderRadius:12,padding:14,marginBottom:8 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontWeight:800,fontSize:14,color:T.text }}>{loan.warning?"⚠️ ":""}{loan.name}</div>
                      <div style={{ fontSize:11,color:T.muted,marginTop:2 }}>
                        {loan.bank} · {loan.rate}% · 만기 {loan.maturity}
                        <span style={{ marginLeft:8,background:dark?"#1E2D4A":T.bg3,padding:"1px 6px",borderRadius:4,fontSize:10 }}>{loan.type}</span>
                      </div>
                    </div>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginLeft:12 }}>
                      <div style={{ fontWeight:900,fontSize:15,color:T.danger,...numFont }}>{fmtM(loan.balance)}원</div>
                      <button onClick={()=>setEditLoan(loan)} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>수정</button>
                      <button onClick={()=>{if(window.confirm(`"${loan.name}" 대출을 삭제할까요?`))updateLoans(p=>p.filter(x=>x.id!==loan.id));}} style={{ background:T.danger,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>삭제</button>
                    </div>
                  </div>
                  {upcoming.length>0 && (
                    <div style={{ marginTop:10,borderTop:`1px solid ${T.border}`,paddingTop:10 }}>
                      {upcoming.map((s,i)=>(
                        <div key={i} style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:T.muted,marginBottom:4 }}>
                          <span style={{ color:T.acc,...numFont }}>{s.date}</span>
                          <span>원금 {fmt(s.principal)} + 이자 {fmt(s.interest)}</span>
                          <span style={{ color:T.ok,fontWeight:700,...numFont }}>₩{fmt(s.total)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <button onClick={()=>setShowLoanModal(true)} style={{ width:"100%",padding:"12px",background:"none",border:`1.5px dashed ${T.border2}`,borderRadius:12,cursor:"pointer",fontSize:13,color:T.acc,fontWeight:700 }}>+ 대출 추가</button>
          </div>
        )}

        {/* ══════════════════ 고정비 관리 탭 ══════════════════ */}
        {tab==="고정비 관리" && (
          <div className="fu">
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
              <div>
                <div style={{ fontSize:16,fontWeight:800,color:T.text }}>🏢 사업 운영 고정비</div>
                <div style={{ fontSize:11,color:T.muted,marginTop:2 }}>월 총계 <span style={{ color:T.warn,fontWeight:700,...numFont }}>₩{fmt(costs.reduce((s,c)=>s+c.amount,0))}</span></div>
              </div>
              <button onClick={()=>setShowCostModal(true)} style={{ background:T.ok,color:"#fff",border:"none",borderRadius:8,padding:"9px 16px",fontSize:13,fontWeight:700,cursor:"pointer" }}>➕ 항목 추가</button>
            </div>
            {costs.map(c=>(
              <div key={c.id} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderLeft:`4px solid ${c.color}`,borderRadius:12,padding:14,marginBottom:8 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:700,fontSize:14,color:T.text }}>{c.name}</div>
                    <div style={{ fontSize:11,color:T.muted,marginTop:2 }}>매월 {c.payDay}일 · {c.category}</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                    <div style={{ fontWeight:900,fontSize:16,color:c.color,...numFont }}>₩{fmt(c.amount)}</div>
                    <button onClick={()=>{const v=prompt("금액 수정 (원):",c.amount);if(v)updateCosts(p=>p.map(x=>x.id===c.id?{...x,amount:Number(v)}:x));}} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>수정</button>
                    <button onClick={()=>updateCosts(p=>p.filter(x=>x.id!==c.id))} style={{ background:T.danger,color:"#fff",border:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer" }}>삭제</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ══════════════════ 계좌 관리 탭 ══════════════════ */}
        {tab==="계좌 관리" && (
          <div className="fu">
            {/* 요약 카드 */}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14 }}>
              {[
                {l:"💰 총 잔액",   v:accounts.reduce((s,a)=>s+a.balance,0), c:T.ok},
                {l:"🏦 계좌 수",   v:accounts.length+"개",                   c:T.acc, isStr:true},
                {l:"📊 이번달 지출",v:monthTotal.total,                       c:T.danger},
              ].map((s,i)=>(
                <div key={i} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px" }}>
                  <div style={{ fontSize:11,color:T.muted,marginBottom:6 }}>{s.l}</div>
                  <div style={{ fontSize:18,fontWeight:400,color:s.c,...numFont }}>{s.isStr?s.v:"₩"+fmt(s.v)}</div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom:14 }}>
              {accounts.map(a=>(
                <div key={a.id} style={{ background:T.bg2,border:`1px solid ${T.border}`,borderLeft:`4px solid ${a.color}`,borderRadius:12,padding:16,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:700,fontSize:15,color:T.text }}>{a.name}</div>
                    <div style={{ fontSize:12,color:T.muted,marginTop:4 }}>현재 잔액</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                    <div style={{ fontSize:22,fontWeight:400,color:a.balance>=0?T.ok:T.danger,...numFont }}>₩{fmt(a.balance)}</div>
                    <div style={{ display:"flex",gap:6 }}>
                      <button onClick={()=>{const v=prompt(`${a.name} 잔액 수정 (원):`,a.balance);if(v!==null&&v!=="")updateAccounts(p=>p.map(x=>x.id===a.id?{...x,balance:Number(v)}:x));}} style={{ background:T.acc,color:"#fff",border:"none",borderRadius:6,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer" }}>잔액 수정</button>
                      <button onClick={()=>setEditAccount(a)} style={{ background:T.bg3,color:T.text,border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer" }}>수정</button>
                      <button onClick={()=>{if(window.confirm(`${a.name} 계좌를 삭제할까요?`))updateAccounts(p=>p.filter(x=>x.id!==a.id));}} style={{ background:T.danger,color:"#fff",border:"none",borderRadius:6,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer" }}>삭제</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={()=>setShowAccountModal(true)} style={{ width:"100%",padding:"13px",background:"none",border:`1.5px dashed ${T.border2}`,borderRadius:12,cursor:"pointer",fontSize:14,color:T.acc,fontWeight:700 }}>+ 계좌 추가</button>
            <div style={{ marginTop:16,background:dark?"#0A1020":"#EFF6FF",border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 16px",fontSize:12,color:T.sub,lineHeight:1.7 }}>
              <div>{"💡 "}잔액 계산 방법</div>
              <div style={{marginTop:4}}>전체 계좌 잔액 합계를 가계부의 시작 잔액으로 사용합니다.</div>
              <div>수입 및 지출 메모를 기록하면 잔액이 자동으로 계산됩니다.</div>
              <div>실제 은행 잔액과 맞지 않을 때는 <span style={{fontWeight:700}}>잔액 수정</span> 버튼으로 직접 조정하세요.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 루트 컴포넌트 ────────────────────────────────────────────
export default function App() {
  const [user, setUser]           = useState(null);
  const [authLoading, setLoading] = useState(true);
  const [dark, setDark]           = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => {
      setUser(u || null);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  if (authLoading) return (
    <div style={{ minHeight:"100vh",background:"#070B18",display:"flex",alignItems:"center",justifyContent:"center",color:"#475569",fontFamily:"'Noto Sans KR',sans-serif",fontSize:16 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@700&display=swap');`}</style>
      🔄 인증 확인 중...
    </div>
  );

  if (!user) return <LoginScreen dark={dark} />;
  return <FinanceApp user={user} />;
}
