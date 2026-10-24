import { useMutation, useQuery } from "convex/react";
import { api } from "../api";
import { href } from "../router";
import { Clay } from "./Clay";
import { ago, initials, Spinner, useNow } from "./bits";
import link from "../assets/link.json";

export function Home({ myName }: { myName: string }) {
  const people = useQuery(api.people.list);
  const feed = useQuery(api.activity.feed);
  const markAllRead = useMutation(api.activity.markAllRead);
  const now = useNow(60_000);
  const unread = feed?.filter((n) => !n.read).length ?? 0;
  const first = myName.split(" ")[0];

  if (people === undefined) return <Spinner label="Loading" />;

  if (people.length === 0)
    return (
      <section className="empty card">
        <Clay doc={link} width={360} height={160} inputs={{ connected: 0 }} className="hero-clay" label="Their JustAsk and you, waiting to connect" />
        <h1>Hi {first}. Who do you help?</h1>
        <p className="muted">Set up JustAsk for a parent, grandparent or friend. It takes about five minutes, and you can do it together or from afar.</p>
        <a className="btn primary big" href={href({ name: "new" })}>
          Set up JustAsk for someone
        </a>
        <div className="paths">
          <div>
            <strong>They don't have JustAsk yet</strong>
            <span>You'll make their profile and get a code to type on their computer.</span>
          </div>
          <div>
            <strong>They already use JustAsk</strong>
            <span>Same steps. Their name and settings stay; you just get connected.</span>
          </div>
        </div>
      </section>
    );

  return (
    <div className="home">
      <section>
        <div className="section-head">
          <h1>People you help</h1>
          <a className="btn primary" href={href({ name: "new" })}>
            + Add someone
          </a>
        </div>
        <ul className="people">
          {people.map((p) => (
            <li key={p.id}>
              <a className="person-card card" href={href({ name: "person", id: p.id })}>
                <span className="avatar-lg" aria-hidden="true">
                  {initials(p.name)}
                </span>
                <span className="pc-main">
                  <span className="pc-name">{p.name}</span>
                  <span className="muted small">
                    {p.relation ? `${p.relation} · ` : ""}JustAsk calls them “{p.displayName}”
                  </span>
                </span>
                <span className="pc-side">
                  {p.connected ? <span className="pill ok">Connected</span> : <span className="pill warn">Not connected yet</span>}
                  {p.waiting > 0 && <span className="muted small">{p.waiting} waiting</span>}
                  {p.finished !== null && p.finished > 0 && <span className="muted small">{p.finished} done</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <aside className="feed card" aria-labelledby="feed-h">
        <div className="section-head">
          <h2 id="feed-h">Activity</h2>
          {unread > 0 && (
            <button className="linkbtn" onClick={() => void markAllRead()}>
              Mark all read
            </button>
          )}
        </div>
        {feed === undefined ? (
          <Spinner label="Loading" />
        ) : feed.length === 0 ? (
          <p className="muted small">
            When someone finishes a task you sent, or gets stuck, you'll see it here. They choose whether to share this on their computer.
          </p>
        ) : (
          <ul className="feed-list">
            {feed.map((n) => (
              <li key={n.id} className={n.read ? "" : "unread"}>
                <span className="feed-text">{n.text}</span>
                <span className="muted small">{ago(n.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
