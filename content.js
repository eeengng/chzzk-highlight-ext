console.log("[Chzzk Highlight Ext] Content script loaded.");

// ─────────────────────────────────────────
// 상수
// ─────────────────────────────────────────
const PEAK_WINDOW = 10;  // 밀도 계산 윈도우: 10초
const CLIP_BEFORE = 25;  // 피크 시작 기준 앞으로 25초
const CLIP_AFTER  = 25;  // 피크 종료 기준 뒤로  25초
// → 총 클립 길이: 25 + 10 + 25 = 60초

// ─────────────────────────────────────────
// 상태
// ─────────────────────────────────────────
let config      = { enabled: true, highlightCount: 20 };
let isAnalyzing = false;
let analyzeBtn  = null;
let floatPanel  = null;
let lastVideoId = null;

// 전역 분석 데이터 (구간 필터 재분석에 활용)
let g_allChatTimes  = [];
let g_vodDuration   = 0;
let g_videoId       = '';
let g_rangeStart    = 0;   // 필터 시작 (초), 0 = 전체
let g_rangeEnd      = 0;   // 필터 종료 (초), 0 = 전체

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
    chrome.storage.local.get(['enabled', 'highlightCount'], (res) => {
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
        const chats = await fetchAllChats(videoId);
        console.log(`[Chzzk Highlight] 전체 채팅: ${chats.length}개`);

        if (chats.length === 0) {
            hideLoading();
            alert("채팅 데이터를 가져오지 못했습니다.\n치지직에 로그인되어 있는지 확인해 주세요.");
            isAnalyzing = false;
            return;
        }

        const allTimes   = chats.map(c => c.time);
        const vodStartMs = Math.min(...allTimes);
        const vodEndMs   = Math.max(...allTimes);
        const vodDuration = (vodEndMs - vodStartMs) / 1000;
        const chatTimes  = chats.map(c => (c.time - vodStartMs) / 1000);

        // 전역 저장 (재분석용)
        g_allChatTimes = chatTimes;
        g_vodDuration  = vodDuration;
        g_videoId      = videoId;
        g_rangeStart   = 0;
        g_rangeEnd     = vodDuration;

        const highlights = calculateHighlights(chatTimes, vodDuration);
        hideLoading();
        renderFloatPanel(highlights, chatTimes, videoId, vodDuration, 0, vodDuration);

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
// ─────────────────────────────────────────
function calculateHighlights(chatTimes, vodDurationSec) {
    if (!chatTimes.length) return [];

    const targetCount = config.highlightCount;
    const minGapSec   = Math.max(60, vodDurationSec / (targetCount * 2));

    const sorted = [...chatTimes].sort((a, b) => a - b);
    const densities = [];
    let right = 0;
    for (let i = 0; i < sorted.length; i++) {
        const windowStart = sorted[i];
        const windowEnd   = windowStart + PEAK_WINDOW;
        while (right < sorted.length && sorted[right] <= windowEnd) right++;
        densities.push({ windowStart, windowEnd, count: right - i });
    }

    densities.sort((a, b) => b.count - a.count);

    const peaks = [];
    for (const d of densities) {
        if (!peaks.some(p => Math.abs(p.windowStart - d.windowStart) < minGapSec)) {
            peaks.push(d);
            if (peaks.length >= config.highlightCount) break;
        }
    }

    peaks.sort((a, b) => b.count - a.count);
    return peaks.map((p, i) => ({
        rank:      i + 1,
        peakStart: p.windowStart,
        peakEnd:   p.windowEnd,
        density:   p.count,
        clipStart: Math.max(0, p.windowStart - CLIP_BEFORE),
        clipEnd:   p.windowEnd + CLIP_AFTER,
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
// rangeStart/rangeEnd: 현재 적용된 구간 필터(초)
// ─────────────────────────────────────────
function renderFloatPanel(highlights, chatTimes, videoId, vodDurationSec, rangeStart, rangeEnd) {
    if (floatPanel) floatPanel.remove();

    const totalCount    = g_allChatTimes.length;
    const filteredCount = chatTimes.length;
    const durationLabel = vodDurationSec ? formatTime(vodDurationSec) : '-';
    const isFiltered    = rangeStart > 0 || rangeEnd < vodDurationSec;

    let itemsHtml = '';
    if (highlights.length === 0) {
        itemsHtml = `<div class="chzzk-fp-empty">😅 해당 구간에서 하이라이트 구간이 감지되지 않았습니다.</div>`;
    } else {
        highlights.forEach(hl => {
            itemsHtml += `
            <div class="chzzk-fp-item">
                <div class="chzzk-fp-item-rank">#${hl.rank}</div>
                <div class="chzzk-fp-item-body">
                    <div class="chzzk-fp-item-times">
                        <button type="button" class="chzzk-time-btn comment_item_time__6KPQu"
                            data-time="${hl.clipStart}" title="클립 시작 위치로 이동">
                            ${formatTime(hl.clipStart)}
                        </button>
                        <span class="chzzk-fp-sep">~</span>
                        <button type="button" class="chzzk-time-btn comment_item_time__6KPQu"
                            data-time="${hl.clipEnd}" title="클립 종료 위치로 이동">
                            ${formatTime(hl.clipEnd)}
                        </button>
                        <span class="chzzk-fp-clip-len">60초</span>
                    </div>
                    <div class="chzzk-fp-item-peak">
                        채팅 집중 구간: ${formatTime(hl.peakStart)} ~ ${formatTime(hl.peakEnd)}
                    </div>
                </div>
                <div class="chzzk-fp-item-density">🔥 ${hl.density}<small>/10초</small></div>
            </div>`;
        });
    }

    // 구간 필터 슬라이더 초기값 (% 단위)
    const startPct = Math.round((rangeStart / vodDurationSec) * 100);
    const endPct   = Math.round((rangeEnd   / vodDurationSec) * 100);

    floatPanel = document.createElement('div');
    floatPanel.id        = 'CHZZK_FLOAT_PANEL';
    floatPanel.className = 'chzzk-float-panel';
    floatPanel.innerHTML = `
        <!-- 드래그 핸들(헤더) -->
        <div class="chzzk-fp-header" id="CHZZK_FP_DRAG">
            <div class="chzzk-fp-header-left">
                <span class="chzzk-fp-title">🔥 하이라이트</span>
                <span class="chzzk-fp-meta">
                    #${videoId} · ${durationLabel} · 채팅 ${totalCount.toLocaleString()}개
                    ${isFiltered ? `<span class="chzzk-fp-filter-badge">구간 필터 적용</span>` : ''}
                </span>
            </div>
            <div class="chzzk-fp-header-btns">
                <button class="chzzk-fp-ctrl" id="CHZZK_FP_MINIMIZE" title="접기">−</button>
                <button class="chzzk-fp-ctrl" id="CHZZK_FP_CLOSE"    title="닫기">✕</button>
            </div>
        </div>

        <!-- 접을 때 숨겨지는 영역 -->
        <div class="chzzk-fp-body" id="CHZZK_FP_BODY">

            <!-- 차트 -->
            <div class="chzzk-fp-chart-wrap">
                <canvas id="HIGHLIGHT_CHART"></canvas>
            </div>

            <!-- 구간 필터 토글 버튼 -->
            <div class="chzzk-fp-filter-toggle-wrap">
                <button class="chzzk-fp-filter-toggle ${isFiltered ? 'active' : ''}" id="CHZZK_FP_FILTER_TOGGLE">
                    ${isFiltered ? '✂️ 구간 필터 적용됨' : '✂️ 구간 필터'}
                </button>
                ${isFiltered ? `<button class="chzzk-fp-filter-reset" id="CHZZK_FP_FILTER_RESET">전체로 복원</button>` : ''}
            </div>

            <!-- 구간 필터 패널 (토글로 펼쳐짐) -->
            <div class="chzzk-fp-filter-panel ${isFiltered ? '' : 'hidden'}" id="CHZZK_FP_FILTER_PANEL">
                <div class="chzzk-fp-filter-desc">
                    방송 시작·종료 시점의 채팅 몰림을 제외하고 싶을 때 구간을 조정하세요.
                </div>
                <div class="chzzk-fp-slider-row">
                    <span class="chzzk-fp-slider-label">시작</span>
                    <input type="range" id="CHZZK_RANGE_START" class="chzzk-range-slider"
                        min="0" max="100" value="${startPct}" step="1">
                    <span class="chzzk-fp-slider-val" id="CHZZK_START_VAL">${formatTime(rangeStart)}</span>
                </div>
                <div class="chzzk-fp-slider-row">
                    <span class="chzzk-fp-slider-label">종료</span>
                    <input type="range" id="CHZZK_RANGE_END" class="chzzk-range-slider"
                        min="0" max="100" value="${endPct}" step="1">
                    <span class="chzzk-fp-slider-val" id="CHZZK_END_VAL">${formatTime(rangeEnd)}</span>
                </div>
                <div class="chzzk-fp-filter-range-preview" id="CHZZK_RANGE_PREVIEW">
                    분석 구간: <strong>${formatTime(rangeStart)}</strong> ~ <strong>${formatTime(rangeEnd)}</strong>
                    <span class="chzzk-fp-range-count">(채팅 ${filteredCount.toLocaleString()}개)</span>
                </div>
                <button class="chzzk-fp-reanalyze-btn" id="CHZZK_FP_REANALYZE">
                    이 구간으로 재분석
                </button>
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
    const fpBody  = document.getElementById('CHZZK_FP_BODY');
    const minBtn  = document.getElementById('CHZZK_FP_MINIMIZE');
    let minimized = false;
    minBtn.addEventListener('click', () => {
        minimized = !minimized;
        fpBody.style.display   = minimized ? 'none' : '';
        minBtn.textContent     = minimized ? '+' : '−';
        floatPanel.style.width = minimized ? 'auto' : '';
    });

    // ── 드래그 ──
    makeDraggable(floatPanel, document.getElementById('CHZZK_FP_DRAG'));

    // ── 타임스탬프 버튼 클릭 ──
    floatPanel.querySelectorAll('.chzzk-time-btn').forEach(btn => {
        btn.addEventListener('click', () => jumpToTime(parseFloat(btn.getAttribute('data-time'))));
    });

    // ── 구간 필터 토글 ──
    const filterToggle = document.getElementById('CHZZK_FP_FILTER_TOGGLE');
    const filterPanel  = document.getElementById('CHZZK_FP_FILTER_PANEL');
    filterToggle.addEventListener('click', () => {
        const willOpen = filterPanel.classList.contains('hidden');
        filterPanel.classList.toggle('hidden');
        filterToggle.classList.toggle('active', willOpen);
        filterToggle.textContent = willOpen ? '✂️ 구간 필터 ▲' : '✂️ 구간 필터 ▼';
    });

    // ── 전체로 복원 ──
    const resetBtn = document.getElementById('CHZZK_FP_FILTER_RESET');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            g_rangeStart = 0;
            g_rangeEnd   = g_vodDuration;
            const all        = g_allChatTimes;
            const highlights = calculateHighlights(all, g_vodDuration);
            renderFloatPanel(highlights, all, g_videoId, g_vodDuration, 0, g_vodDuration);
        });
    }

    // ── 슬라이더 인터랙션 ──
    const sliderStart    = document.getElementById('CHZZK_RANGE_START');
    const sliderEnd      = document.getElementById('CHZZK_RANGE_END');
    const startValEl     = document.getElementById('CHZZK_START_VAL');
    const endValEl       = document.getElementById('CHZZK_END_VAL');
    const previewEl      = document.getElementById('CHZZK_RANGE_PREVIEW');

    let localStart = rangeStart;
    let localEnd   = rangeEnd;

    function updateSliderUI() {
        // 시작이 종료를 역전하지 않도록
        if (localStart >= localEnd - 30) {
            localStart = Math.max(0, localEnd - 30);
            sliderStart.value = Math.round((localStart / vodDurationSec) * 100);
        }
        startValEl.textContent = formatTime(localStart);
        endValEl.textContent   = formatTime(localEnd);

        const inRange = g_allChatTimes.filter(t => t >= localStart && t <= localEnd).length;
        previewEl.innerHTML = `분석 구간: <strong>${formatTime(localStart)}</strong> ~ <strong>${formatTime(localEnd)}</strong>
            <span class="chzzk-fp-range-count">(채팅 ${inRange.toLocaleString()}개)</span>`;

        // 차트에 선택 구간 음영 업데이트
        renderChartCanvas(g_allChatTimes, vodDurationSec, highlights, localStart, localEnd);
    }

    sliderStart.addEventListener('input', () => {
        localStart = Math.round((sliderStart.value / 100) * vodDurationSec);
        updateSliderUI();
    });
    sliderEnd.addEventListener('input', () => {
        localEnd = Math.round((sliderEnd.value / 100) * vodDurationSec);
        // 종료가 시작을 역전하지 않도록
        if (localEnd <= localStart + 30) {
            localEnd = Math.min(vodDurationSec, localStart + 30);
            sliderEnd.value = Math.round((localEnd / vodDurationSec) * 100);
        }
        updateSliderUI();
    });

    // ── 재분석 버튼 ──
    document.getElementById('CHZZK_FP_REANALYZE').addEventListener('click', () => {
        g_rangeStart = localStart;
        g_rangeEnd   = localEnd;
        const filtered   = g_allChatTimes.filter(t => t >= localStart && t <= localEnd);
        const highlights = calculateHighlights(filtered, localEnd - localStart);
        renderFloatPanel(highlights, filtered, g_videoId, g_vodDuration, localStart, localEnd);
    });

    // ── 차트 (구간 음영 포함) ──
    requestAnimationFrame(() =>
        renderChartCanvas(g_allChatTimes, vodDurationSec, highlights, rangeStart, rangeEnd)
    );
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
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = rect.left + 'px';
        el.style.top    = rect.top  + 'px';

        function onMove(e) {
            let nx = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  e.clientX - ox));
            let ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, e.clientY - oy));
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
// rangeStart/rangeEnd: 현재 슬라이더 구간 (음영 표시용)
// ─────────────────────────────────────────
function renderChartCanvas(chatTimes, vodDurationSec, highlights, rangeStart, rangeEnd) {
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

    // 선택 구간 외부 음영
    if (rangeStart !== undefined && rangeEnd !== undefined) {
        const xs = (rangeStart / duration) * canvas.width;
        const xe = (rangeEnd   / duration) * canvas.width;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0,  0, xs,              h);
        ctx.fillRect(xe, 0, canvas.width - xe, h);

        // 구간 경계선
        ctx.strokeStyle = 'rgba(255,255,100,0.7)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(xs, 0); ctx.lineTo(xs, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xe, 0); ctx.lineTo(xe, h); ctx.stroke();
        ctx.setLineDash([]);
    }

    // 막대 그래프
    for (let i = 0; i < BUCKETS; i++) {
        const barH = (buckets[i] / maxCount) * (h - 4);
        if (barH <= 0) continue;

        const inPeak = (highlights || []).some(hl => {
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
    (highlights || []).forEach(hl => {
        const cx = ((hl.peakStart + hl.peakEnd) / 2 / duration) * canvas.width;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
        ctx.fillStyle = 'rgba(255,80,80,0.9)';
        ctx.font      = 'bold 10px sans-serif';
        ctx.fillText(`#${hl.rank}`, cx + 3, 11);
    });
}

init();
