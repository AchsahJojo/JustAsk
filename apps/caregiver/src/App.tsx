import { useEffect, useState } from "react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "./api";
import { useRoute, href } from "./router";
import { SignIn, PENDING_NAME_KEY } from "./ui/SignIn";
import { Home } from "./ui/Home";
import { SetupWizard } from "./ui/SetupWizard";
import { Person } from "./ui/Person";
import { Account } from "./ui/Account";
import { Brand, Spinner } from "./ui/bits";

export function App() {
  return (
    <>
      <AuthLoading>
        <div className="center-page">
          <Spinner label="Loading" />
        </div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <SignedIn />
      </Authenticated>
    </>
  );
}

/** Creates the caregiver profile on first sign-in, then shows the app. */
function SignedIn() {
  const me = useQuery(api.caregivers.me);
  const ensure = useMutation(api.caregivers.ensureProfile);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (me !== null) return;
    let name: string | undefined;
    try {
      name = sessionStorage.getItem(PENDING_NAME_KEY) ?? undefined;
    } catch {
      /* storage blocked */
    }
    ensure({ name })
      .then(() => {
        try {
          sessionStorage.removeItem(PENDING_NAME_KEY);
        } catch {
          /* storage blocked */
        }
      })
      .catch(() => setFailed(true));
  }, [me, ensure]);

  if (failed) return <ProfileError />;
  if (!me)
    return (
      <div className="center-page">
        <Spinner label="Setting up your account" />
      </div>
    );
  return <Shell name={me.name} />;
}

function ProfileError() {
  const { signOut } = useAuthActions();
  return (
    <main className="center-page">
      <div className="card narrow">
        <h1>We couldn't finish signing you in</h1>
        <p className="muted">Check your connection and try again.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => location.reload()}>
            Try again
          </button>
          <button className="btn ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}

function Shell({ name }: { name: string }) {
  const route = useRoute();
  const unread = useQuery(api.activity.feed)?.filter((n) => !n.read).length ?? 0;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand-link" href={href({ name: "home" })} aria-label="JustAsk for helpers, home">
          <Brand />
        </a>
        <nav className="topnav">
          <a href={href({ name: "home" })} className={route.name === "home" ? "on" : ""}>
            People{unread > 0 && <span className="dot" aria-label={`${unread} new`} />}
          </a>
          <a href={href({ name: "account" })} className={`avatar ${route.name === "account" ? "on" : ""}`} title="Your account">
            <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>
            <span className="sr">Your account</span>
          </a>
        </nav>
      </header>
      <main className="page">
        {route.name === "home" && <Home myName={name} />}
        {route.name === "new" && <SetupWizard />}
        {route.name === "person" && <Person id={route.id} />}
        {route.name === "account" && <Account />}
      </main>
    </div>
  );
}
