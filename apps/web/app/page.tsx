export default function Home() {
  return (
    <main
      style={{
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        padding: "4rem 2rem",
        maxWidth: 720,
        margin: "0 auto",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>GA App</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        General Aviation tooling — scaffold deploy.
      </p>
      <p>
        Liveness probe: <a href="/health">/health</a>
      </p>
      <p style={{ fontSize: "0.85rem", color: "#888", marginTop: "3rem" }}>
        Not for navigational use.
      </p>
    </main>
  );
}
