console.log("[Chzzk Highlight Ext] Content script loaded.");

// ─────────────────────────────────────────
// 상수
// ─────────────────────────────────────────
const PEAK_WINDOW  = 10;  // 밀도 계산 윈도우: 10초
const CLIP_BEFORE  = 25;  // 피크 시작 기준 앞으로 25초
const CLIP_AFTER   = 25;  // 피크 종료 기준 뒤로  25초
// → 총 클립 길이: 25 + 10 + 25 = 60초

// ─────────────────────────────────────────
// 상태
// ─────────────────────────────────────────
let config       = { enabled: true, highlightCount: 20 };
let isAnalyzing  = false;
let analyzeBtn   = null;
let floatPanel   = null;
let lastVideoId  = null;

// ─────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────
function getCurrentVideoId() {
    const m = location.pathname.match(/\/video\/(\d+)/);
    return m ? m[1] : null;
}
function isVodPage() { return !!getCurrentVideoId(); }

function formatTime(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m}:${s.toString().padStart(2,'0')}`;
}

function jumpToTime(sec) {
    const video = document.querySelector('video');
    if (video) video.currentTime = sec;
}

// ─────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────
function init() {
    loadConfig(() => tryInjectButton());

    const observer = new MutationObserver(() => {
        if (!config.enabled) return;
        if (isVodPage()) {
            if (!analyzeBtn || !document.body.contains(analyzeBtn)) {
                analyzeBtn = null;
                tryInjectButton();
            }
        } else {
            cleanupUI();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        const newId = getCurrentVideoId();
        if (newId) {
            if (newId !== lastVideoId && floatPanel) { floatPanel.remove(); floatPanel = null; }
            analyzeBtn = null;
            if (config.enabled) tryInjectButton();
        } else {
            cleanupUI();
        }
    }, 800);

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.enabled !== undefined) {
            config.enabled = changes.enabled.newValue;
            if (!config.enabled) cleanupUI();
            else if (isVodPage()) tryInjectButton();
        }
        if (changes.highlightCount) config.highlightCount = changes.highlightCount.newValue;
    });
}

function loadConfig(cb) {
    chrome.storage.local.get(['enabled', 'algorithm', 'highlightCount'], (res) => {
        config.enabled        = res.enabled        !== false;
        config.highlightCount = res.highlightCount || 20;
        cb && cb();
    });
}

function cleanupUI() {
    if (analyzeBtn) { analyzeBtn.remove(); analyzeBtn = null; }
    if (floatPanel) { floatPanel.remove(); floatPanel = null; }
}

// ─────────────────────────────────────────
// FAB 버튼 삽입
// ─────────────────────────────────────────
function tryInjectButton() {
    if (!isVodPage() || !config.enabled) return;
    if (analyzeBtn && document.body.contains(analyzeBtn)) return;

    analyzeBtn = document.createElement('button');
    analyzeBtn.id        = 'CHZZK_HIGHLIGHT_BTN';
    analyzeBtn.className = 'chzzk-highlight-fab';
    analyzeBtn.innerHTML = `<span class="chzzk-fab-icon">⚡</span><span class="chzzk-fab-label">하이라이트 분석</span>`;
    analyzeBtn.onclick   = handleAnalyzeClick;
    document.body.appendChild(analyzeBtn);
}

// ─────────────────────────────────────────
// 분석 실행
// ─────────────────────────────────────────
async function handleAnalyzeClick() {
    if (isAnalyzing) return;
    const videoId = getCurrentVideoId();
    if (!videoId) { alert("치지직 다시보기 페이지에서 실행해 주세요."); return; }

    isAnalyzing = true;
    lastVideoId = videoId;
    showLoading();

    try {
        // 전체 채팅 수집 (필터링 없음)
        const chats = await fetchAllChats(videoId);
        console.log(`[Chzzk Highlight] 전체 채팅: ${chats.length}개`);

        if (chats.length === 0) {
            hideLoading();
            alert("채팅 데이터를 가져오지 못했습니다.\n치지직에 로그인되어 있는지 확인해 주세요.");
            isAnalyzing = false;
            return;
        }

        // 절대 타임스탬프 → 상대 초 단위
        const allTimes    = chats.map(c => c.time);
        const vodStartMs  = Math.min(...allTimes);
        const vodEndMs    = Math.max(...allTimes);
        const vodDuration = (vodEndMs - vodStartMs) / 1000;

        // 모든 채팅의 상대 시각(초) — 필터링 없이 전체 사용
        const chatTimes = chats.map(c => (c.time - vodStartMs) / 1000);

        console.log(`[Chzzk Highlight] VOD 길이: ${formatTime(vodDuration)}, 채팅 수: ${chatTimes.length}`);

        const highlights = calculateHighlights(chatTimes, vodDuration);
        console.log(`[Chzzk Highlight] 하이라이트: ${highlights.length}개`, highlights);

        hideLoading();
        renderFloatPanel(highlights, chatTimes, videoId, vodDuration);

    } catch (err) {
        console.error('[Chzzk Highlight] 오류:', err);
        alert("분석 중 오류: " + err.message);
        hideLoading();
    }

    isAnalyzing = false;
}

// ─────────────────────────────────────────
// API 호출 (페이지네이션)
// ─────────────────────────────────────────
async function fetchAllChats(videoId) {
    let nextPlayerMessageTime = "0";
    let allChats = [];

    for (let i = 0; i < 2000; i++) {
        updateLoadingText(`채팅 로딩 중... ${allChats.length.toLocaleString()}개 수집됨`);

        const url = `https://api.chzzk.naver.com/service/v1/videos/${videoId}/chats?playerMessageTime=${nextPlayerMessageTime}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`API 요청 실패 (${res.status})`);

        const data = await res.json();
        if (data.code !== 200 || !data.content?.videoChats?.length) break;

        data.content.videoChats.forEach(c => {
            allChats.push({ time: c.messageTime, content: c.content || "" });
        });

        nextPlayerMessageTime = data.content.nextPlayerMessageTime;
        if (nextPlayerMessageTime == null) break;
    }

    return allChats;
}

// ─────────────────────────────────────────
// 하이라이트 피크 계산
// - 10초 슬라이딩 윈도우로 전체 채팅 밀도 계산
// - 최소 간격(minGap) 조건으로 중복 제거
// - 클립: 피크 시작 -25초 ~ 피크 종료(+10초) +25초 = 총 60초
// ─────────────────────────────────────────
function calculateHighlights(chatTimes, vodDurationSec) {
    if (!chatTimes.length) return [];

    const targetCount = config.highlightCount;
    // VOD 길이 비례로 최소 간격 설정 (최소 60초)
    const minGapSec   = Math.max(60, vodDurationSec / (targetCount * 2));

    // 시간순 정렬
    const sorted = [...chatTimes].sort((a, b) => a - b);

    // 10초 슬라이딩 윈도우 밀도 계산
    const densities = [];
    let right = 0;
    for (let i = 0; i < sorted.length; i++) {
        const windowStart = sorted[i];
        const windowEnd   = windowStart + PEAK_WINDOW;
        while (right < sorted.length && sorted[right] <= windowEnd) right++;
        densities.push({ windowStart, windowEnd, count: right - i });
    }

    // 밀도 내림차순
    densities.sort((a, b) => b.count - a.count);

    // 최소 간격 조건으로 피크 선별
    const peaks = [];
    for (const d of densities) {
        if (!peaks.some(p => Math.abs(p.windowStart - d.windowStart) < minGapSec)) {
            peaks.push(d);
            if (peaks.length >= config.highlightCount) break;
        }
    }

    // 밀도 내림차순 유지
    peaks.sort((a, b) => b.count - a.count);

    return peaks.map((p, i) => ({
        rank:        i + 1,
        peakStart:   p.windowStart,             // 채팅 집중 구간 시작
        peakEnd:     p.windowEnd,               // 채팅 집중 구간 종료 (=시작+10초)
        density:     p.count,
        clipStart:   Math.max(0, p.windowStart - CLIP_BEFORE),   // 클립 시작
        clipEnd:     p.windowEnd   + CLIP_AFTER,                  // 클립 종료
    }));
}

// ─────────────────────────────────────────
// 로딩 UI
// ─────────────────────────────────────────
function showLoading() {
    if (document.getElementById('HIGHLIGHT_LOADING')) return;
    const el = document.createElement('div');
    el.id        = 'HIGHLIGHT_LOADING';
    el.className = 'chzzk-loading-overlay';
    el.innerHTML = `
        <div class="chzzk-spinner"></div>
        <div class="chzzk-loading-text" id="HIGHLIGHT_LOADING_TEXT">채팅 데이터를 불러오는 중...</div>
    `;
    document.body.appendChild(el);
}
function updateLoadingText(t) {
    const el = document.getElementById('HIGHLIGHT_LOADING_TEXT');
    if (el) el.innerText = t;
}
function hideLoading() {
    const el = document.getElementById('HIGHLIGHT_LOADING');
    if (el) el.remove();
}

// ─────────────────────────────────────────
// 드래그 가능한 플로팅 패널 렌더링
// ─────────────────────────────────────────
function renderFloatPanel(highlights, chatTimes, videoId, vodDurationSec) {
    if (floatPanel) floatPanel.remove();

    const laughCount    = chatTimes.length;
    const durationLabel = vodDurationSec ? formatTime(vodDurationSec) : '-';

    // 하이라이트 아이템 HTML
    let itemsHtml = '';
    if (highlights.length === 0) {
        itemsHtml = `<div class="chzzk-fp-empty">😅 하이라이트 구간이 감지되지 않았습니다.</div>`;
    } else {
        highlights.forEach(hl => {
            itemsHtml += `
            <div class="chzzk-fp-item">
                <div class="chzzk-fp-item-rank">#${hl.rank}</div>
                <div class="chzzk-fp-item-body">
                    <div class="chzzk-fp-item-times">
                        <button type="button" class="chzzk-time-btn comment_item_time__6KPQu"
                            data-time="${hl.clipStart}"
                            title="클립 시작 위치로 이동">
                            ${formatTime(hl.clipStart)}
                        </button>
                        <span class="chzzk-fp-sep">~</span>
                        <button type="button" class="chzzk-time-btn comment_item_time__6KPQu"
                            data-time="${hl.clipEnd}"
                            title="클립 종료 위치로 이동">
                            ${formatTime(hl.clipEnd)}
                        </button>
                        <span class="chzzk-fp-clip-len">60초</span>
                    </div>
                    <div class="chzzk-fp-item-peak">
                        채팅 집중 구간: ${formatTime(hl.peakStart)} ~ ${formatTime(hl.peakEnd)}
                    </div>
                </div>
                <div class="chzzk-fp-item-density">
                    🔥 ${hl.density}<small>/10초</small>
                </div>
            </div>`;
        });
    }

    floatPanel = document.createElement('div');
    floatPanel.id        = 'CHZZK_FLOAT_PANEL';
    floatPanel.className = 'chzzk-float-panel';
    floatPanel.innerHTML = `
        <!-- 드래그 핸들(헤더) -->
        <div class="chzzk-fp-header" id="CHZZK_FP_DRAG">
            <div class="chzzk-fp-header-left">
                <span class="chzzk-fp-title">🔥 하이라이트</span>
                <span class="chzzk-fp-meta">
                    #${videoId} · ${durationLabel} · 채팅 ${laughCount.toLocaleString()}개
                </span>
            </div>
            <div class="chzzk-fp-header-btns">
                <button class="chzzk-fp-ctrl" id="CHZZK_FP_MINIMIZE" title="접기">−</button>
                <button class="chzzk-fp-ctrl" id="CHZZK_FP_CLOSE"    title="닫기">✕</button>
            </div>
        </div>

        <!-- 접을 때 숨겨지는 영역 -->
        <div class="chzzk-fp-body" id="CHZZK_FP_BODY">
            <div class="chzzk-fp-chart-wrap">
                <canvas id="HIGHLIGHT_CHART"></canvas>
            </div>
            <div class="chzzk-fp-sort-label">🔽 반응 강도 순 정렬</div>
            <div class="chzzk-fp-list">
                ${itemsHtml}
            </div>
        </div>
    `;

    document.body.appendChild(floatPanel);

    // ── 닫기 ──
    document.getElementById('CHZZK_FP_CLOSE').addEventListener('click', () => {
        floatPanel.remove(); floatPanel = null;
    });

    // ── 최소화/복원 ──
    const fpBody    = document.getElementById('CHZZK_FP_BODY');
    const minBtn    = document.getElementById('CHZZK_FP_MINIMIZE');
    let minimized   = false;
    minBtn.addEventListener('click', () => {
        minimized = !minimized;
        fpBody.style.display = minimized ? 'none' : '';
        minBtn.textContent   = minimized ? '+' : '−';
        floatPanel.style.width = minimized ? 'auto' : '';
    });

    // ── 드래그 ──
    makeDraggable(floatPanel, document.getElementById('CHZZK_FP_DRAG'));

    // ── 타임스탬프 버튼 클릭 ──
    floatPanel.querySelectorAll('.chzzk-time-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            jumpToTime(parseFloat(btn.getAttribute('data-time')));
        });
    });

    // ── 차트 ──
    requestAnimationFrame(() => renderChartCanvas(chatTimes, vodDurationSec, highlights));
}

// ─────────────────────────────────────────
// 드래그 구현
// ─────────────────────────────────────────
function makeDraggable(el, handle) {
    let ox = 0, oy = 0;

    handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();

        const rect = el.getBoundingClientRect();
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;

        // fixed 모드로 전환
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = rect.left + 'px';
        el.style.top    = rect.top  + 'px';

        function onMove(e) {
            let nx = e.clientX - ox;
            let ny = e.clientY - oy;
            // 화면 경계 제한
            nx = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  nx));
            ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ny));
            el.style.left = nx + 'px';
            el.style.top  = ny + 'px';
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

// ─────────────────────────────────────────
// Canvas 차트 렌더링
// ─────────────────────────────────────────
function renderChartCanvas(chatTimes, vodDurationSec, highlights) {
    const canvas = document.getElementById('HIGHLIGHT_CHART');
    if (!canvas || !chatTimes.length) return;

    const wrap = canvas.parentElement;
    canvas.width  = wrap.clientWidth  || 320;
    canvas.height = wrap.clientHeight || 80;

    const ctx      = canvas.getContext('2d');
    const duration = vodDurationSec || Math.max(...chatTimes);
    if (!duration || duration <= 0) return;

    const BUCKETS = 80;
    const buckets = new Array(BUCKETS).fill(0);
    chatTimes.forEach(t => {
        const idx = Math.min(BUCKETS - 1, Math.floor((t / duration) * BUCKETS));
        buckets[idx]++;
    });

    const maxCount = Math.max(...buckets) || 1;
    const bw       = canvas.width / BUCKETS;
    const h        = canvas.height;

    for (let i = 0; i < BUCKETS; i++) {
        const barH = (buckets[i] / maxCount) * (h - 4);
        if (barH <= 0) continue;

        // 하이라이트 피크 구간은 주황색
        const inPeak = highlights.some(hl => {
            const rs = hl.peakStart / duration;
            const re = hl.peakEnd   / duration;
            const bi = i / BUCKETS;
            return bi >= rs - 1/BUCKETS && bi <= re + 1/BUCKETS;
        });
        ctx.fillStyle = inPeak ? 'rgba(255,160,60,0.95)' : 'rgba(0,255,163,0.65)';
        ctx.fillRect(i * bw, h - barH, bw - 1, barH);
    }

    // 피크 중심 세로선 + 순위
    ctx.strokeStyle = 'rgba(255,80,80,0.9)';
    ctx.lineWidth   = 2;
    highlights.forEach(hl => {
        const cx = ((hl.peakStart + hl.peakEnd) / 2 / duration) * canvas.width;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
        ctx.fillStyle = 'rgba(255,80,80,0.9)';
        ctx.font      = 'bold 10px sans-serif';
        ctx.fillText(`#${hl.rank}`, cx + 3, 11);
    });
}

init();
