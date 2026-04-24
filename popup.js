document.addEventListener('DOMContentLoaded', () => {
    const enabledToggle       = document.getElementById('enabledToggle');
    const toggleText          = document.getElementById('toggle-text');
    const popupBody           = document.getElementById('popupBody');
    const highlightCountInput = document.getElementById('highlightCount');
    const saveBtn             = document.getElementById('saveBtn');
    const statusDiv           = document.getElementById('status');

    // ── 저장된 설정 불러오기 ──
    chrome.storage.local.get(['enabled', 'highlightCount'], (res) => {
        const isEnabled = res.enabled !== false;
        enabledToggle.checked     = isEnabled;
        highlightCountInput.value = res.highlightCount || 20;
        applyEnabledState(isEnabled);
    });

    // ── On/Off 토글 (즉시 저장) ──
    enabledToggle.addEventListener('change', () => {
        const isEnabled = enabledToggle.checked;
        applyEnabledState(isEnabled);
        chrome.storage.local.set({ enabled: isEnabled });
        flashStatus(isEnabled ? '✅ 기능 활성화됨' : '⛔ 기능 비활성화됨');
    });

    // ── 저장 버튼 ──
    saveBtn.addEventListener('click', () => {
        const count = Math.max(1, Math.min(50, parseInt(highlightCountInput.value) || 20));
        highlightCountInput.value = count; // 범위 보정 후 표시

        chrome.storage.local.set({
            enabled:        enabledToggle.checked,
            highlightCount: count,
        }, () => {
            flashStatus('💾 저장되었습니다!');
        });
    });

    // ── 헬퍼 ──
    function applyEnabledState(isEnabled) {
        toggleText.textContent = isEnabled ? 'ON' : 'OFF';
        popupBody.classList.toggle('disabled', !isEnabled);
    }

    function flashStatus(msg) {
        statusDiv.textContent = msg;
        clearTimeout(flashStatus._timer);
        flashStatus._timer = setTimeout(() => { statusDiv.textContent = ''; }, 2200);
    }
});
