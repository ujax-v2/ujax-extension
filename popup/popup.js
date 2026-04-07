// popup.js
// 수동 크롤링 트리거 + 수집 현황 + 연동 상태 표시
(function () {
  const numInput = document.getElementById("problemNum");
  const crawlBtn = document.getElementById("crawlBtn");
  const statusEl = document.getElementById("status");
  const countEl = document.getElementById("count");
  const ujaxBadge = document.getElementById("ujaxBadge");
  const bojBadge = document.getElementById("bojBadge");

  // 수집된 문제 수 표시
  chrome.storage.local.get("crawledProblems", ({ crawledProblems }) => {
    countEl.textContent = (crawledProblems || []).length;
  });

  // 연동 상태 표시 (BOJ 아이디는 프론트 기준으로만 사용)
  chrome.storage.local.get(
    ["ujaxToken", "frontBojId"],
    ({ ujaxToken, frontBojId }) => {
      if (ujaxToken) {
        ujaxBadge.textContent = "연결됨";
        ujaxBadge.className = "badge badge-ok";
      }
      if (frontBojId) {
        bojBadge.textContent = `${frontBojId} (프론트)`;
        bojBadge.className = "badge badge-ok";
      } else {
        bojBadge.textContent = "프론트 기준 미설정";
        bojBadge.className = "badge badge-no";
      }
    }
  );

  crawlBtn.addEventListener("click", () => {
    const num = parseInt(numInput.value, 10);
    if (!num || num <= 0) {
      statusEl.textContent = "올바른 문제 번호를 입력하세요.";
      return;
    }

    chrome.runtime.sendMessage({ type: "manualCrawl", problemNum: num });
    statusEl.textContent = `${num}번 문제 페이지를 여는 중...`;
  });

  numInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") crawlBtn.click();
  });
})();
