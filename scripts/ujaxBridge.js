// ujaxBridge.js
// ──────────────────────────────────────────────────────────────
// UJAX 프론트엔드 페이지에서 실행되는 Content Script
// localStorage의 인증 토큰을 읽어 확장 프로그램으로 전달한다.
// ──────────────────────────────────────────────────────────────
(function () {
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
})();
