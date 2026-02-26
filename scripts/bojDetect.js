// bojDetect.js
// ──────────────────────────────────────────────────────────────
// 모든 acmicpc.net 페이지에서 로그인된 백준 유저명을 감지하여
// background.js로 전달한다.
// ──────────────────────────────────────────────────────────────
(function () {
  // 백준 상단 네비게이션에서 로그인된 유저 링크를 찾는다.
  // 로그인 상태: <a href="/user/{username}"> 형태가 상단 메뉴에 존재
  const userLink = document.querySelector(
    ".nav-wrapper a[href^='/user/'], #statusBar a[href^='/user/'], .navbar a[href^='/user/']"
  );

  if (!userLink) return;

  const href = userLink.getAttribute("href");
  const username = href.replace("/user/", "").split("/")[0].trim();

  if (!username) return;

  chrome.runtime.sendMessage({ type: "bojUsername", username });
  console.log(`[UJAX] 백준 유저 감지: ${username}`);
})();
