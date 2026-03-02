// ujaxBridge.js
// ──────────────────────────────────────────────────────────────
// UJAX 프론트엔드 페이지에서 실행되는 Content Script
// 1) localStorage의 인증 토큰을 읽어 확장 프로그램으로 전달
// 2) 프론트엔드 ↔ 확장 프로그램 간 크롤링 요청/완료 메시지 중계
// ──────────────────────────────────────────────────────────────
(function () {
  /** extension 컨텍스트가 유효한지 확인 (리로드/업데이트 후 무효화 방지) */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // ── 토큰 전달 ──────────────────────────────────────────────

  function sendToken() {
    try {
      const raw = localStorage.getItem("auth");
      if (!raw) {
        safeSendMessage({ type: "ujaxToken", token: null });
        return;
      }
      const auth = JSON.parse(raw);
      if (auth.accessToken) {
        safeSendMessage({
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

  // ── 프론트 → 확장 프로그램 메시지 중계 ────────────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    // 토큰 갱신 (같은 탭에서 refreshToken 시 storage 이벤트가 안 발생하므로 직접 전달)
    if (event.data?.type === "ujaxTokenRefreshed" && event.data?.token) {
      safeSendMessage({
        type: "ujaxToken",
        token: event.data.token,
      });
    }
    if (event.data?.type === "ujaxCrawlRequest" && event.data?.problemNum) {
      safeSendMessage({
        type: "crawlRequest",
        problemNum: event.data.problemNum,
      });
    }
    if (event.data?.type === "ujaxProblemContext" && event.data?.problemNum && event.data?.workspaceProblemId) {
      safeSendMessage({
        type: "problemContext",
        problemNum: event.data.problemNum,
        workspaceProblemId: event.data.workspaceProblemId,
      });
    }
    if (event.data?.type === "ujaxSubmitRequest" && event.data?.problemNum && event.data?.code) {
      safeSendMessage({
        type: "submitRequest",
        problemNum: event.data.problemNum,
        code: event.data.code,
        language: event.data.language,
      });
    }
  });

  // ── 크롤링 완료 중계: 확장 프로그램 → 프론트 ────────────────

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "crawlComplete") {
        const msg = {
          type: "ujaxCrawlComplete",
          problemNum: message.problemNum,
          success: message.success,
        };
        if (message.reason) msg.reason = message.reason;
        window.postMessage(msg, "*");
      }
      if (message?.type === "submissionResult") {
        window.postMessage({
          type: "ujaxSubmissionResult",
          problemNum: message.problemNum,
          verdict: message.verdict,
          submissionId: message.submissionId,
          time: message.time,
          memory: message.memory,
          language: message.language,
        }, "*");
      }
    });
  }
})();
