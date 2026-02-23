/* PRAMAAN — script.js v4 */

const API_BASE = '';
const USER_ID = localStorage.getItem('pramaan_uid') || (() => {
  const id = 'user-' + Math.random().toString(36).slice(2);
  localStorage.setItem('pramaan_uid', id);
  return id;
})();

let caseId = null, caseProfile = null, isSending = false;
let isRecording = false, speechRec = null, mediaRec = null;
let audioChunks = [], uploadedFiles = [], analysisLoaded = false;
let cameraStream = null, facingMode = 'environment', capturedImageBlob = null;
let audioEvidenceRec = null, audioEvidenceChunks = [], audioEvidenceBlob = null;
let audioTimerInterval = null, audioSeconds = 0, audioAnalyser = null, audioAnimFrame = null;
let dark = true;

// ── NAVIGATION ──
function go(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('act'));
  document.getElementById('nl-' + id)?.classList.add('act');
  window.scrollTo(0, 0);
  if (id === 'dashboard') loadDashboard();
}

function toggleTheme() {
  dark = !dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('thBtn').textContent = dark ? '🌙' : '☀️';
  localStorage.setItem('pramaan_theme', dark ? 'dark' : 'light');
}

// ── STEPPER ──
function gotoStep(n) {
  [1,2,3].forEach(i => document.getElementById('bs'+i).style.display = i===n?'block':'none');
  updStepper(n);
  window.scrollTo(0,0);
  if (n===3) loadAnalysis();
}

function updStepper(n) {
  [1,2,3].forEach(i => {
    const c = document.getElementById('sc'+i), l = document.getElementById('sl'+i);
    if (i<n)        { c.className='st-circle done'; c.textContent='✓'; l.className='st-lbl done'; }
    else if (i===n) { c.className='st-circle act';  c.textContent=i;   l.className='st-lbl act';  }
    else            { c.className='st-circle pend'; c.textContent=i;   l.className='st-lbl pend'; }
  });
  [1,2].forEach(i => {
    document.getElementById('sln'+i).className = 'st-line'+(i<n?' done':i===n?' act':'');
  });
}

// ── CHAT ──
async function sendMsg() {
  const inp = document.getElementById('ci');
  const v = inp.value.trim();
  if (!v || isSending) return;
  inp.value = '';
  await processMessage(v);
}

async function processMessage(text, fromVoice) {
  if (isSending) return;
  isSending = true;
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) { sendBtn.disabled=true; sendBtn.textContent='⏳'; }
  addBubble('user', fromVoice ? '🎤 '+text : text);
  const typId = showTyping();
  try {
    const res = await fetch(API_BASE+'/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:text, caseId, userId:USER_ID }),
    });
    const data = await res.json();
    hideTyping(typId);
    if (!res.ok) throw new Error(data.error||'Server error');
    addBubble('ai', data.response||data.message||'');
    caseId = data.caseId;
    caseProfile = data.profile;
    analysisLoaded = false;
    updateProgressBar(data.profile);
    updateFactsPanel(data.profile);
    if (data.analysis)    showStrengthBadge(data.analysis);
    if (data.readyToFile) showReadyToFile();
  } catch(err) {
    hideTyping(typId);
    addBubble('ai', '⚠️ Connection issue. Please check your internet and try again.', 'err');
  } finally {
    isSending = false;
    if (sendBtn) { sendBtn.disabled=false; sendBtn.textContent='✈️'; }
  }
}

function formatAIText(t) {
  return t
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/^(\d+)\. (.+)$/gm,'<div class="ai-list-item"><span class="ai-num">$1</span><span>$2</span></div>')
    .replace(/^- (.+)$/gm,'<div class="ai-bullet">• $1</div>')
    .replace(/\n\n/g,'<div class="ai-spacer"></div>')
    .replace(/\n/g,'<br>');
}

function addBubble(role, text, cls) {
  const area = document.getElementById('chatArea');
  const div  = document.createElement('div');
  div.className = role==='user' ? 'msg-user' : ('msg-ai'+(cls?' msg-'+cls:''));
  if (role==='ai') div.innerHTML = formatAIText(text);
  else div.textContent = text;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function showTyping() {
  const area = document.getElementById('chatArea');
  const id   = 'typ'+Date.now();
  const div  = document.createElement('div');
  div.className='typ'; div.id=id;
  div.innerHTML='<span></span><span></span><span></span>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
  return id;
}
function hideTyping(id) { document.getElementById(id)?.remove(); }

function updateProgressBar(profile) {
  if (!profile) return;
  const slots = ['caseType','incident','incidentDate','otherParty','documents','desiredOutcome'];
  const filled = slots.filter(s => profile[s]).length;
  const pct = Math.round(8+(filled/slots.length)*92);
  const bar = document.getElementById('pf'), lbl = document.getElementById('pp');
  if (bar) bar.style.width = pct+'%';
  if (lbl) lbl.textContent = pct+'%';
}

function updateFactsPanel(profile) {
  if (!profile) return;
  const panel = document.getElementById('factsPanel');
  if (!panel) return;
  panel.innerHTML = '';
  const chips = [
    ['⚖️', profile.caseType],
    ['📋', profile.incident?.slice(0,55)],
    ['📅', profile.incidentDate],
    ['👤', profile.otherParty],
    ['📍', profile.location],
    ['📄', profile.documents?.slice(0,40)],
    ['🎯', profile.desiredOutcome?.slice(0,40)],
  ].filter(([,v]) => v);
  chips.forEach(([icon,val]) => {
    const c = document.createElement('div');
    c.className = 'fact-chip';
    c.innerHTML = '<span>'+icon+'</span><span class="chip-val">'+esc(val)+'</span>';
    panel.appendChild(c);
  });
  panel.style.display = chips.length ? 'flex' : 'none';
}

function showStrengthBadge(analysis) {
  document.getElementById('strengthBadge')?.remove();
  const area = document.getElementById('chatArea');
  const pct  = analysis?.analysis?.strengthPercentage ?? 65;
  const tip  = (analysis?.analysis?.strategy ?? '').slice(0,140);
  const div  = document.createElement('div');
  div.id = 'strengthBadge'; div.className = 'strength-badge';
  div.innerHTML = '<div class="sb-row"><div class="sb-ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--border2)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="var(--orange)" stroke-width="4" stroke-dasharray="'+Math.round(pct*1.13)+' 113" stroke-linecap="round" transform="rotate(-90 22 22)"/></svg><span>'+pct+'%</span></div><div class="sb-info"><div class="sb-ttl">⚡ Case Strength: <strong>'+(pct>=70?'Strong':pct>=50?'Moderate':'Needs work')+'</strong></div><div class="sb-tip">'+esc(tip)+'…</div></div></div>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function showReadyToFile() {
  if (document.getElementById('readyBanner')) return;
  const area = document.getElementById('chatArea');
  const div  = document.createElement('div');
  div.id = 'readyBanner'; div.className = 'ready-banner';
  div.innerHTML = '<div class="rb-icon">✅</div><div class="rb-text"><strong>All information collected!</strong><span>Your case profile is ready. Upload evidence to strengthen it.</span></div><button class="btn-nxt" onclick="gotoStep(2)" style="margin-top:12px;width:100%">Next: Upload Evidence →</button>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
  document.querySelector('.nxt-wrap .btn-nxt')?.classList.add('pulse');
}

// ── VOICE ──
function toggleVoice() { isRecording ? stopVoice() : startVoice(); }

function startVoice() {
  const btn = document.getElementById('voiceBtn');
  const inp = document.getElementById('ci');
  const SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    speechRec = new SR();
    speechRec.continuous = false;
    speechRec.interimResults = false;
    speechRec.lang = 'en-IN';
    speechRec.onstart = () => {
      isRecording = true;
      setVoiceBtnState(btn, true);
      inp.placeholder = '🎤 Listening… speak now';
      inp.value = '';
    };
    speechRec.onresult = e => {
      const final = e.results[e.results.length-1];
      if (final.isFinal) inp.value = final[0].transcript.trim();
    };
    speechRec.onend = () => {
      isRecording = false;
      setVoiceBtnState(btn, false);
      inp.placeholder = 'Describe your problem in your own words…';
      if (inp.value.trim()) setTimeout(sendMsg, 300);
    };
    speechRec.onerror = e => {
      isRecording = false;
      setVoiceBtnState(btn, false);
      inp.placeholder = 'Describe your problem in your own words…';
      if (e.error !== 'aborted' && e.error !== 'no-speech') fallbackToMediaRecorder(btn);
    };
    try { speechRec.start(); } catch { fallbackToMediaRecorder(btn); }
    return;
  }
  fallbackToMediaRecorder(btn);
}

async function fallbackToMediaRecorder(btn) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    audioChunks = [];
    mediaRec = new MediaRecorder(stream, { mimeType:'audio/webm' });
    mediaRec.ondataavailable = e => { if(e.data.size>0) audioChunks.push(e.data); };
    mediaRec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.textContent='⏳'; btn.disabled=true;
      const blob = new Blob(audioChunks, { type:'audio/webm' });
      const form = new FormData();
      form.append('audio', blob, 'voice.webm');
      form.append('caseId', caseId??'');
      form.append('userId', USER_ID);
      try {
        const res  = await fetch(API_BASE+'/api/chat', { method:'POST', body:form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        addBubble('ai', data.response||'');
        caseId = data.caseId; caseProfile = data.profile; analysisLoaded = false;
        updateProgressBar(data.profile); updateFactsPanel(data.profile);
        if (data.analysis)    showStrengthBadge(data.analysis);
        if (data.readyToFile) showReadyToFile();
      } catch { addBubble('ai','⚠️ Could not process audio. Please type your message.','err'); }
      finally { btn.textContent='🎤'; btn.disabled=false; isRecording=false; setVoiceBtnState(btn,false); }
    };
    mediaRec.start(); isRecording=true; setVoiceBtnState(btn,true);
  } catch { alert('Microphone access denied.'); }
}

function stopVoice() {
  if (speechRec) speechRec.stop();
  if (mediaRec && mediaRec.state!=='inactive') mediaRec.stop();
}

function setVoiceBtnState(btn, recording) {
  if (!btn) return;
  if (recording) { btn.classList.add('recording'); btn.innerHTML='<span class="rec-dot"></span> Stop'; }
  else           { btn.classList.remove('recording'); btn.innerHTML='🎤'; }
}

function togMode(mode, btn) {
  document.querySelectorAll('.tog-btn').forEach(b => b.classList.remove('act'));
  btn.classList.add('act');
  const textRow  = document.getElementById('textInputRow');
  const voiceRow = document.getElementById('voiceInputRow');
  if (mode==='voice') {
    if (textRow)  textRow.style.display='none';
    if (voiceRow) voiceRow.style.display='flex';
    setTimeout(startVoice, 300);
  } else {
    if (textRow)  textRow.style.display='flex';
    if (voiceRow) voiceRow.style.display='none';
    if (isRecording) stopVoice();
    document.getElementById('ci')?.focus();
  }
}

// ── CAMERA ──
async function openCamera() {
  document.getElementById('cameraModal').style.display='flex';
  await startCamera();
}

async function startCamera() {
  try {
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width:{ideal:1920}, height:{ideal:1080} }
    });
    document.getElementById('cameraFeed').srcObject = cameraStream;
    document.getElementById('capturePreview').style.display='none';
    document.getElementById('cameraFeed').style.display='block';
  } catch {
    alert('Camera access denied.');
    closeCamera();
  }
}

function switchCamera() {
  facingMode = facingMode==='environment' ? 'user' : 'environment';
  startCamera();
}

function capturePhoto() {
  const video=document.getElementById('cameraFeed'), canvas=document.getElementById('cameraCanvas');
  canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  canvas.getContext('2d').drawImage(video,0,0);
  canvas.toBlob(blob => {
    capturedImageBlob=blob;
    document.getElementById('capturedImg').src=URL.createObjectURL(blob);
    document.getElementById('cameraFeed').style.display='none';
    document.getElementById('capturePreview').style.display='block';
  },'image/jpeg',0.92);
}

function retakePhoto() {
  capturedImageBlob=null;
  document.getElementById('cameraFeed').style.display='block';
  document.getElementById('capturePreview').style.display='none';
}

function useCapture() {
  if (!capturedImageBlob) return;
  const file = new File([capturedImageBlob],'camera-'+Date.now()+'.jpg',{type:'image/jpeg'});
  closeCamera();
  uploadEvidence(file);
}

function closeCamera() {
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  cameraStream=null;
  document.getElementById('cameraModal').style.display='none';
}

// ── AUDIO EVIDENCE ──
function openAudioModal() {
  document.getElementById('audioModal').style.display='flex';
  resetAudioState();
}

function closeAudioModal() {
  stopAudioEvidence();
  document.getElementById('audioModal').style.display='none';
  resetAudioState();
}

function resetAudioState() {
  clearInterval(audioTimerInterval);
  cancelAnimationFrame(audioAnimFrame);
  audioSeconds=0; audioEvidenceChunks=[]; audioEvidenceBlob=null;
  document.getElementById('audioTimer').textContent='0:00';
  document.getElementById('audioStatus').textContent='Tap record to start';
  document.getElementById('audioRecBtn').textContent='🎙️';
  document.getElementById('audioRecBtn').style.background='var(--orange)';
  document.getElementById('audioActions').style.display='none';
}

function formatTime(s) { return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }

async function toggleAudioRecord() {
  if (audioEvidenceRec && audioEvidenceRec.state==='recording') stopAudioEvidence();
  else await startAudioEvidence();
}

async function startAudioEvidence() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    audioEvidenceChunks=[];
    audioEvidenceRec = new MediaRecorder(stream, { mimeType:'audio/webm' });
    audioEvidenceRec.ondataavailable = e => { if(e.data.size>0) audioEvidenceChunks.push(e.data); };
    audioEvidenceRec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      audioEvidenceBlob = new Blob(audioEvidenceChunks,{type:'audio/webm'});
      document.getElementById('audioStatus').textContent='Recording ready — '+formatTime(audioSeconds);
      document.getElementById('audioActions').style.display='flex';
    };
    audioEvidenceRec.start(100);
    document.getElementById('audioRecBtn').textContent='⏹️';
    document.getElementById('audioRecBtn').style.background='#dc2626';
    document.getElementById('audioStatus').textContent='Recording…';
    audioSeconds=0;
    audioTimerInterval = setInterval(() => {
      audioSeconds++;
      document.getElementById('audioTimer').textContent=formatTime(audioSeconds);
    },1000);
  } catch { alert('Microphone access denied.'); }
}

function stopAudioEvidence() {
  clearInterval(audioTimerInterval);
  if (audioEvidenceRec && audioEvidenceRec.state==='recording') audioEvidenceRec.stop();
}

async function uploadAudioEvidence() {
  if (!audioEvidenceBlob) return;
  const file = new File([audioEvidenceBlob],'audio-evidence-'+Date.now()+'.webm',{type:'audio/webm'});
  closeAudioModal();
  uploadEvidence(file);
}

function discardAudio() { resetAudioState(); }

// ── DRAG & DROP ──
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('dropzone')?.classList.add('drag-over');
}
function handleDragLeave() {
  document.getElementById('dropzone')?.classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone')?.classList.remove('drag-over');
  [...e.dataTransfer.files].forEach(f => uploadEvidence(f));
}

// ── EVIDENCE UPLOAD ──
function addFile() {
  const input=document.createElement('input');
  input.type='file'; input.multiple=true;
  input.accept='.pdf,.jpg,.jpeg,.png,.webp,.mp3,.wav,.webm';
  input.onchange = e => [...e.target.files].forEach(f => uploadEvidence(f));
  input.click();
}

async function uploadEvidence(file) {
  const ef=document.getElementById('extraFiles');
  const fid='ev'+Date.now();
  const card=document.createElement('div');
  card.className='f-item fade-in'; card.id=fid;
  card.innerHTML='<span class="f-ico">'+fileIcon(file.type)+'</span><span class="f-nm">'+esc(file.name)+' <span style="opacity:.5;font-size:11px">'+fmtSize(file.size)+'</span></span><span class="f-prev" id="'+fid+'st">⏳ Uploading...</span>';
  document.getElementById('noFilesMsg')?.remove();
  ef.appendChild(card);
  if (!caseId) { document.getElementById(fid+'st').textContent='⚠️ Complete Step 1 first'; return; }
  try {
    const form=new FormData();
    form.append('file',file); form.append('case_id',caseId); form.append('user_id',USER_ID);
    const res  = await fetch(API_BASE+'/api/upload-evidence',{method:'POST',body:form});
    const data = await res.json();
    if (!res.ok||!data.success) throw new Error(data.error||'Upload failed');
    uploadedFiles.push(data);
    const st=document.getElementById(fid+'st');
    if(st) st.outerHTML = data.signed_url
      ? '<a class="f-prev" href="'+data.signed_url+'" target="_blank">👁 Preview</a>'
      : '<span class="f-prev" style="color:#4ade80">✓ Saved</span>';
    updateEvidenceChecklist();
  } catch {
    const st=document.getElementById(fid+'st');
    if(st) st.outerHTML='<span class="f-prev" style="color:#f87171">✗ Failed</span>';
  }
}

function fileIcon(m) {
  if(m.startsWith('image/')) return '🖼️';
  if(m.startsWith('audio/')) return '🎵';
  if(m==='application/pdf')  return '📄';
  return '📎';
}
function fmtSize(b) {
  if(b<1024) return b+'B';
  if(b<1048576) return (b/1024).toFixed(1)+'KB';
  return (b/1048576).toFixed(1)+'MB';
}

function updateEvidenceChecklist() {
  const latest=[...uploadedFiles].reverse().find(f=>f.summary||f.ocrPreview);
  const ocrBox=document.getElementById('ocrPreviewBox'), ocrTxt=document.getElementById('ocrPreviewText');
  if(latest&&ocrBox&&ocrTxt){ ocrTxt.textContent=latest.summary||latest.ocrPreview||''; ocrBox.style.display='block'; }
  const cats={identity:false,incident:false,supporting:false,witness:false};
  uploadedFiles.forEach(f => {
    const text=((f.fileName||'')+' '+(f.summary||'')).toLowerCase();
    if(/aadhaar|pan|passport|voter|id card|licence|birth/.test(text)) cats.identity=true;
    else if(/fir|complaint|incident|photo|image|video|audio|evidence/.test(text)) cats.incident=true;
    else if(/deed|agreement|contract|receipt|invoice|bill|bank|cheque|notice/.test(text)) cats.supporting=true;
    else if(/witness|affidavit|declaration|sworn/.test(text)) cats.witness=true;
    else {
      const idx=uploadedFiles.indexOf(f);
      if(idx===0) cats.identity=true;
      else if(idx===1) cats.incident=true;
      else if(idx===2) cats.supporting=true;
      else cats.witness=true;
    }
  });
  let done=0;
  [['identity','ck-identity-circ','ck-identity-lbl'],
   ['incident','ck-incident-circ','ck-incident-lbl'],
   ['supporting','ck-supporting-circ','ck-supporting-lbl'],
   ['witness','ck-witness-circ','ck-witness-lbl']].forEach(([cat,cid,lid]) => {
    const circ=document.getElementById(cid), lbl=document.getElementById(lid);
    if(!circ) return;
    if(cats[cat]){ circ.className='ck-circ done'; circ.textContent='✓'; if(lbl) lbl.style.color=''; done++; }
    else         { circ.className='ck-circ pend'; circ.textContent='';  if(lbl) lbl.style.color='var(--text3)'; }
  });
  const pct=Math.min(Math.round(done/4*100),100);
  const bar=document.getElementById('evPf'), lbl=document.getElementById('evPp');
  if(bar) bar.style.width=pct+'%';
  if(lbl) lbl.textContent=pct+'%';
}

// ── ANALYSIS ──
async function loadAnalysis() {
  if(analysisLoaded && document.getElementById('analysisContent')?.style.display!=='none') return;
  const loading=document.getElementById('analysisLoading');
  const content=document.getElementById('analysisContent');
  const errBox=document.getElementById('analysisError');
  const errMsg=document.getElementById('analysisErrorMsg');
  const dossierBtn=document.getElementById('genDossierBtn');
  loading.style.display='block'; content.style.display='none'; errBox.style.display='none';
  if(dossierBtn){ dossierBtn.disabled=true; dossierBtn.style.opacity='0.5'; }
  if(!caseId){
    loading.style.display='none'; errBox.style.display='block';
    if(errMsg) errMsg.textContent='No active case. Please complete Step 1 first.';
    return;
  }
  try {
    const res=await fetch(API_BASE+'/api/generate-case',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({caseId, userId:USER_ID, profile:caseProfile}),
    });
    const ct=res.headers.get('content-type')??'';
    if(!ct.includes('application/json')) throw new Error(res.status===404?'API route not found.':'Server error '+res.status);
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Analysis failed');
    const analysis=data.analysis??{};
    const laws=analysis.laws??[], cases=analysis.similarCases??[];
    const stratData=analysis.analysis??{};
    const strategy=stratData.strategy??'', strengthPct=stratData.strengthPercentage??0;
    const victoryPath=stratData.victoryPath??'';
    const warnings=stratData.warnings??'';
    const forum=stratData.forum??'';

    const lawsEl=document.getElementById('ab-laws');
    if(lawsEl) lawsEl.innerHTML=laws.length
      ? laws.map(l=>'<div class="law-it"><div class="law-hd2"><span class="law-sec">'+esc(l.section)+'</span><span class="law-act">'+esc(l.act)+'</span></div><div class="law-desc">'+esc(l.description)+'</div>'+(l.source_url?'<a class="rd-lnk" href="'+esc(l.source_url)+'" target="_blank" rel="noopener">▶ Read full text →</a>':'')+'</div>').join('')
      : '<p style="padding:12px;color:var(--text3);font-size:13px">No specific law sections found.</p>';
    document.getElementById('lawsCount').textContent=laws.length;

    const casesEl=document.getElementById('ab-cases');
    if(casesEl) casesEl.innerHTML=cases.length
      ? cases.map(c=>{
          const oc=/won|granted|allowed/i.test(c.outcome)?'cs-out':/dismissed|rejected/i.test(c.outcome)?'cs-out-neg':'cs-out-neu';
          return '<div class="cs-it"><div class="cs-ttl">'+(c.source_url?'<a href="'+esc(c.source_url)+'" target="_blank" style="color:inherit;text-decoration:none">'+esc(c.title)+(c.year?', '+c.year:'')+'</a>':esc(c.title))+'</div><div class="cs-mt">'+(c.court?esc(c.court)+' • ':'')+' <span class="'+oc+'">'+esc(c.outcome)+'</span></div>'+(c.summary?'<div class="cs-sum">'+esc(c.summary.slice(0,160))+'…</div>':'')+(c.citation?'<div style="font-size:11px;color:var(--text3)">'+esc(c.citation)+'</div>':'')+'</div>';
        }).join('')
      : '<p style="padding:12px;color:var(--text3);font-size:13px">No similar cases found.</p>';
    document.getElementById('casesCount').textContent=cases.length;

    const stratEl=document.getElementById('strategyText');
    if(stratEl) stratEl.innerHTML=strategy
      ? esc(strategy)+(strengthPct?' Estimated case strength: <strong style="color:var(--orange)">'+strengthPct+'%</strong>.':'')
      : 'Strategy will appear when you generate the Pramaan Dossier.';

    // Victory direction box
    const abStrat=document.getElementById('ab-strat');
    if(abStrat && (victoryPath||warnings||forum)) {
      const victoryBox=document.createElement('div');
      victoryBox.className='victory-box';
      victoryBox.innerHTML=
        (forum?'<div style="font-size:12px;font-weight:700;color:var(--orange);margin-bottom:8px">🏛️ FILE IN: '+esc(forum)+'</div>':'')+
        (victoryPath?'<div style="font-size:13px;font-weight:600;margin-bottom:6px">🏆 Victory Path</div><div style="font-size:13px;color:var(--text2);line-height:1.6">'+esc(victoryPath)+'</div>':'')+
        (warnings?'<div style="font-size:13px;font-weight:600;margin-top:10px;margin-bottom:4px;color:#f87171">⚠️ Watch Out</div><div style="font-size:13px;color:var(--text2);line-height:1.6">'+esc(warnings)+'</div>':'');
      abStrat.appendChild(victoryBox);
    }

    loading.style.display='none'; content.style.display='block'; analysisLoaded=true;
    if(dossierBtn){ dossierBtn.disabled=false; dossierBtn.style.opacity='1'; }
  } catch(err) {
    loading.style.display='none'; errBox.style.display='block';
    if(errMsg) errMsg.textContent=err.message||'Something went wrong. Please try again.';
  }
}

// ── DOSSIER ──
async function genDossier(e) {
  const btn=e.target;
  btn.textContent='⏳ Building Case File...'; btn.disabled=true;
  try {
    const res=await fetch(API_BASE+'/api/generate-case',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({caseId, userId:USER_ID, profile:caseProfile}),
    });
    const ct=res.headers.get('content-type')??'';
    if(!ct.includes('application/json')) throw new Error('Server error '+res.status);
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Failed');
    if(data.analysis){
      const strat=data.analysis?.analysis?.strategy??'';
      const pct=data.analysis?.analysis?.strengthPercentage??0;
      const stratEl=document.getElementById('strategyText');
      if(stratEl&&strat) stratEl.innerHTML=esc(strat)+(pct?' Strength: <strong style="color:var(--orange)">'+pct+'%</strong>.':'');
      const abStrat=document.getElementById('ab-strat'), chStrat=document.getElementById('ch-strat');
      if(abStrat) abStrat.style.display='block';
      if(chStrat){ chStrat.textContent='▲'; chStrat.className='chev op'; }
    }
    const draftArea=document.getElementById('caseDraftArea');
    if(draftArea){
      draftArea.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><span style="font-weight:600;color:var(--orange)">📋 Legal Complaint Draft</span><button class="btn-sm" onclick="copyDraft()">📋 Copy</button></div><pre class="draft-text" id="draftText">'+esc(data.draft)+'</pre><div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap"><button class="btn-nxt" style="flex:1" onclick="downloadPDF()">📄 Download as PDF</button><button class="btn-nxt" style="flex:1;background:var(--border2);color:var(--text)" onclick="connectLawyer()">👤 Connect to NALSA Lawyer →</button></div><p style="font-size:12px;color:var(--text3);margin-top:10px;line-height:1.6">A NALSA-empanelled lawyer will receive this dossier and contact you within 48 hours.</p>';
      draftArea.style.display='block';
    }
    btn.textContent='✅ Case File Ready'; btn.style.background='#16a34a';
  } catch(err) {
    btn.textContent='📋 Generate Pramaan Dossier'; btn.disabled=false;
    alert('Error: '+err.message);
  }
}

function downloadPDF() {
  const text=document.getElementById('draftText')?.textContent??'';
  if(window.jspdf) generatePDF(text); else downloadDraftText(text);
}

function generatePDF(draftText) {
  try {
    const {jsPDF}=window.jspdf;
    const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight(), margin=20;
    let y=margin;
    doc.setFillColor(249,115,22); doc.rect(0,0,W,18,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text('PRAMAAN — Legal Dossier',margin,12);
    doc.setFontSize(9); doc.text('Generated: '+new Date().toLocaleDateString('en-IN'),W-margin,12,{align:'right'});
    y=28;
    doc.setFillColor(245,245,245); doc.roundedRect(margin,y,W-margin*2,24,3,3,'F');
    doc.setTextColor(30,30,30); doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Case Reference: '+(caseId||'DRAFT'),margin+4,y+8);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('User ID: '+USER_ID,margin+4,y+15);
    if(caseProfile?.caseType) doc.text('Type: '+caseProfile.caseType,margin+4,y+21);
    y+=32;
    doc.setTextColor(30,30,30); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    const lines=doc.splitTextToSize(draftText,W-margin*2);
    lines.forEach(line => {
      if(y>H-30){ doc.addPage(); y=margin; }
      doc.text(line,margin,y); y+=5;
    });
    const totalPages=doc.internal.getNumberOfPages();
    for(let i=1;i<=totalPages;i++){
      doc.setPage(i); doc.setFillColor(249,115,22); doc.rect(0,H-12,W,12,'F');
      doc.setTextColor(255,255,255); doc.setFont('helvetica','normal'); doc.setFontSize(8);
      doc.text('PRAMAAN — Free Legal Access for Every Indian Citizen',margin,H-5);
      doc.text('Page '+i+' of '+totalPages,W-margin,H-5,{align:'right'});
    }
    doc.save('PRAMAAN_Dossier_'+(caseId||'draft')+'.pdf');
  } catch(err) { downloadDraftText(document.getElementById('draftText')?.textContent??''); }
}

function downloadDraftText(text) {
  const a=Object.assign(document.createElement('a'),{
    href: URL.createObjectURL(new Blob([text],{type:'text/plain'})),
    download: 'PRAMAAN_Case_'+(caseId||'draft')+'.txt',
  });
  a.click();
}

function copyDraft() {
  navigator.clipboard.writeText(document.getElementById('draftText')?.textContent??'').then(() => {
    const btn=document.querySelector('.btn-sm');
    if(btn){ btn.textContent='✓ Copied!'; setTimeout(()=>btn.textContent='📋 Copy',2000); }
  });
}

function connectLawyer() {
  go('lawyers');
  setTimeout(()=>document.querySelector('.lw-card')?.scrollIntoView({behavior:'smooth'}),300);
}

function connectToLawyer(btn, name) {
  btn.textContent='✅ Request Sent!'; btn.style.background='#16a34a'; btn.disabled=true;
  setTimeout(()=>{ btn.textContent='⏳ Awaiting Response…'; btn.style.background='var(--border2)'; btn.style.color='var(--text)'; },2500);
}

// ── ACCORDIONS ──
function togAn(id) {
  const b=document.getElementById('ab-'+id), c=document.getElementById('ch-'+id);
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  c.textContent=open?'▼':'▲';
  c.className='chev'+(open?'':' op');
}

// ── DASHBOARD ──
async function loadDashboard() {
  const caseList=document.getElementById('tc1');
  const lawyersTab=document.getElementById('tc3');
  const notifsTab=document.getElementById('tc4');
  if(caseList) caseList.innerHTML='<div style="text-align:center;padding:60px 0;color:var(--text3)"><div class="typ" style="display:inline-flex"><span></span><span></span><span></span></div><div style="margin-top:12px;font-size:14px">Loading your cases...</div></div>';
  try {
    const res=await fetch(API_BASE+'/api/dashboard?userId='+USER_ID);
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Failed to load');
    const cases=data.cases??[], lawyers=data.lawyers??[], notifs=data.notifications??[];
    if(caseList) caseList.innerHTML=cases.length===0
      ? '<div style="text-align:center;padding:60px 0;color:var(--text3)"><div style="font-size:48px;margin-bottom:16px">📁</div><div style="font-size:16px;font-weight:600;margin-bottom:8px">No cases yet</div><div style="font-size:14px;margin-bottom:24px">Start by describing your legal problem</div><button class="btn-or" onclick="go(\'casebuilder\')" style="padding:12px 24px;border-radius:10px">+ Start New Case</button></div>'
      : cases.map(c=>{
          const pct=caseProgress(c);
          const date=new Date(c.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
          const lwyr=c.lawyers?'<span class="m-it">⚖️ '+esc(c.lawyers.name)+'</span>':'';
          return '<div class="c-row" onclick="resumeCase(\''+c.id+'\')" style="cursor:pointer"><div class="c-doc-ico">📄</div><div class="c-info"><div class="c-ttl">'+esc(c.title||'Untitled Case')+'</div><div class="c-meta"><span class="m-it">🕐 '+date+'</span>'+caseStatusBadge(c)+lwyr+'</div></div><div class="c-prog"><div class="p-row"><span>Progress</span><span>'+pct+'%</span></div><div class="pb-w"><div class="pb-f" style="width:'+pct+'%"></div></div></div></div>';
        }).join('');
    if(lawyersTab) lawyersTab.innerHTML=lawyers.length===0
      ? '<div style="text-align:center;padding:60px 0;color:var(--text3)"><div style="font-size:48px;margin-bottom:16px">⚖️</div><div style="font-size:16px;font-weight:600">No lawyers connected yet</div></div>'
      : lawyers.map(l=>'<div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:16px"><div style="font-size:32px">👤</div><div><div style="font-weight:600;font-size:15px">'+esc(l.name)+'</div><div style="font-size:13px;color:var(--text2)">'+esc(l.specialization)+' • '+esc(l.city)+'</div><div style="font-size:12px;color:var(--orange)">⭐ '+l.rating+' • '+l.cases_handled+' cases</div></div></div>').join('');
    if(notifsTab) notifsTab.innerHTML=notifs.length===0
      ? '<div style="text-align:center;padding:60px 0;color:var(--text3)"><div style="font-size:48px;margin-bottom:16px">🔔</div><div style="font-size:16px;font-weight:600">No notifications yet</div></div>'
      : notifs.map(n=>'<div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px 20px"><div style="font-size:14px;font-weight:600;margin-bottom:4px">'+esc(n.title)+'</div><div style="font-size:13px;color:var(--text2)">'+esc(n.body)+'</div></div>').join('');
    const nb=document.querySelector('.nb');
    if(nb) nb.textContent=notifs.length||'';
  } catch(err) {
    if(caseList) caseList.innerHTML='<div style="text-align:center;padding:60px 0;color:var(--text3)"><div style="font-size:40px;margin-bottom:12px">⚠️</div><div style="font-size:15px;font-weight:600;margin-bottom:8px">Could not load cases</div><div style="font-size:13px;margin-bottom:20px">'+esc(err.message)+'</div><button class="btn-or" onclick="loadDashboard()" style="padding:10px 20px;border-radius:10px">↺ Retry</button></div>';
  }
}

function caseProgress(c) { return ({intake:20,analysis:50,filed:85,closed:100})[c.status]??20; }
function caseStatusBadge(c) {
  const s=c.status;
  if(s==='filed'||s==='closed') return '<span class="s-gn">✓ Filed</span>';
  if(s==='analysis')            return '<span class="s-or">✓ Analysis Ready</span>';
  if(c.lawyer_id)               return '<span class="s-or">✓ Lawyer Assigned</span>';
  return '<span class="s-am">✓ In Progress</span>';
}
function resumeCase(id) { caseId=id; analysisLoaded=false; go('casebuilder'); setTimeout(()=>gotoStep(3),200); }

// ── TABS ──
const tabIds=['tc1','tc2','tc3','tc4'];
function switchTab(btn, id) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('act'));
  btn.classList.add('act');
  tabIds.forEach(t=>{
    const el=document.getElementById(t);
    if(!el) return;
    if(t===id){ el.style.display=(t==='tc1'||t==='tc4'||t==='tc3')?'flex':'block'; if(t==='tc1'||t==='tc4'||t==='tc3') el.style.flexDirection='column'; }
    else el.style.display='none';
  });
}

// ── HELPERS ──
function esc(s) { return (s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme=localStorage.getItem('pramaan_theme');
  if(savedTheme==='light'){ dark=false; document.documentElement.setAttribute('data-theme','light'); document.getElementById('thBtn').textContent='☀️'; }
  const tc1=document.getElementById('tc1');
  if(tc1){ tc1.style.display='flex'; tc1.style.flexDirection='column'; }
  const obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{ if(e.isIntersecting){ e.target.style.opacity='1'; e.target.style.transform='translateY(0)'; } });
  },{threshold:0.08});
  document.querySelectorAll('.step-c, .feat-c, .lw-card').forEach(el=>{
    el.style.opacity='0'; el.style.transform='translateY(24px)';
    el.style.transition='opacity 0.5s ease, transform 0.5s ease';
    obs.observe(el);
  });
  document.getElementById('ci')?.addEventListener('keydown', e=>{
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); }
  });
});