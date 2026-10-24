// Shared header/footer for the Maple Pharmacy fixture (ported from Mana's mock site).
const leaf = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#c2410c"/><path d="M12 4.5l1.6 3.3 2.6-1-0.8 3.6 3-0.4-1.9 2.6 1.6 1.4-4 .9.3 2.6-2.4-1.5V19h-1v-3l-2.4 1.5.3-2.6-4-.9 1.6-1.4-1.9-2.6 3 .4-.8-3.6 2.6 1z" fill="#fff"/></svg>`;
document.body.insertAdjacentHTML(
  "afterbegin",
  `<div class="promo"><span>Free delivery on orders over $35 · Flu shots now available, no appointment needed</span><a href="#" data-nb>Learn more</a></div>
  <header class="site">
    <a class="logo" href="/">${leaf} Maple Pharmacy</a>
    <input type="search" placeholder="Search products, brands, services">
    <nav><a href="#" data-nb>Shop</a><a href="/pharmacy/prescriptions">Pharmacy</a><a href="#" data-nb>Health clinic</a><a href="#" data-nb>Weekly ad</a><a href="#" data-nb style="color:#334155">Hi, Margaret</a><button class="cart" data-nb>Cart (0)</button></nav>
  </header>`,
);
document.body.insertAdjacentHTML("beforeend", `<footer class="site">${["Privacy", "Accessibility", "Contact us", "Terms"].map((t) => `<a href="#" data-nb>${t}</a>`).join("")}</footer>`);
document.addEventListener("click", (e) => {
  const nb = e.target.closest("[data-nb]");
  if (!nb) return;
  e.preventDefault();
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = "This part of the demo site isn't built. Only the refill path is.";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
});
