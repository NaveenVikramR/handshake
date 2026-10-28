const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;
const out = document.getElementById("out");
const username = () => document.getElementById("username").value.trim();

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function show(label, value) {
  out.textContent = `${label}\n${JSON.stringify(value, null, 2)}`;
}

document.getElementById("register").addEventListener("click", async () => {
  try {
    const optionsJSON = await post("/register/options", { username: username() });
    const response = await startRegistration({ optionsJSON });
    show("✅ registered", await post("/register/verify", { username: username(), response }));
  } catch (err) {
    show("❌ register failed", String(err));
  }
});

document.getElementById("login").addEventListener("click", async () => {
  try {
    const optionsJSON = await post("/login/options", { username: username() });
    const response = await startAuthentication({ optionsJSON });
    show("✅ logged in", await post("/login/verify", { username: username(), response }));
  } catch (err) {
    show("❌ login failed", String(err));
  }
});
