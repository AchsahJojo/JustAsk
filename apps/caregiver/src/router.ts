import { useEffect, useState } from "react";

export type Route = { name: "home" } | { name: "new" } | { name: "person"; id: string } | { name: "account" };

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h === "new") return { name: "new" };
  if (h === "account") return { name: "account" };
  const m = h.match(/^p\/([\w-]+)$/);
  if (m) return { name: "person", id: m[1] };
  return { name: "home" };
}

export function href(r: Route): string {
  return r.name === "home" ? "#/" : r.name === "person" ? `#/p/${r.id}` : `#/${r.name}`;
}

export function go(r: Route) {
  location.hash = href(r);
}

/** Tiny hash router: the app is a handful of screens and is served as static files. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
