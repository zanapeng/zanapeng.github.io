// ====== 1. 自动更新页脚年份 ======
document.getElementById("year").textContent = new Date().getFullYear();

// ====== 2. 滚动到项目卡片时，让它们淡入出现 ======
const cards = document.querySelectorAll(".reveal");

// IntersectionObserver：当元素进入屏幕视野时触发
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target); // 只播放一次
      }
    });
  },
  { threshold: 0.2 }
);

cards.forEach((card) => observer.observe(card));
