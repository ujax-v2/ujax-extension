// ujaxBridge.js
// ──────────────────────────────────────────────────────────────
// UJAX 프론트엔드 페이지에서 실행되는 Content Script
// 1) localStorage의 인증 토큰을 읽어 확장 프로그램으로 전달
// 2) 프론트엔드 ↔ 확장 프로그램 간 크롤링 요청/완료 메시지 중계
// ──────────────────────────────────────────────────────────────
(function () {
  // ── 토큰 전달 ──────────────────────────────────────────────

  function sendToken() {
    try {
      const raw = localStorage.getItem("auth");
      if (!raw) {
        chrome.runtime.sendMessage({ type: "ujaxToken", token: null });
        return;
      }
      const auth = JSON.parse(raw);
      if (auth.accessToken) {
        chrome.runtime.sendMessage({
          type: "ujaxToken",
          token: auth.accessToken,
        });
      }
    } catch {
      // JSON 파싱 실패 시 무시
    }
  }

  // 페이지 로드 시 토큰 전달
  sendToken();

  // localStorage 변경 감지 (다른 탭에서 로그인/로그아웃 시)
  window.addEventListener("storage", (e) => {
    if (e.key === "auth") sendToken();
  });

  // ── 크롤링 요청 중계: 프론트 → 확장 프로그램 ────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "ujaxCrawlRequest" && event.data?.problemNum) {
      chrome.runtime.sendMessage({
        type: "crawlRequest",
        problemNum: event.data.problemNum,
      });
    }
  });

  // ── 크롤링 완료 중계: 확장 프로그램 → 프론트 ────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "crawlComplete") {
      window.postMessage({
        type: "ujaxCrawlComplete",
        problemNum: message.problemNum,
        success: message.success,
      }, "*");
    }
  });
})();
