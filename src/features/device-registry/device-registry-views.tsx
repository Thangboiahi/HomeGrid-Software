"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SignOutButton } from "@/features/authentication/sign-out-button";

type Device = {
  id: string;
  kind: "simulated" | "physical";
  state: "unassigned" | "assigned" | "retired";
  productDefinitionId: string;
  householdId?: string;
  installationId?: string;
};
type Household = { id: string; displayName?: string };
type Product = { id: string; productCode?: string; displayName?: string; state?: string };
type Installation = { id: string; state: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function Status({ message, error = false }: { message: string; error?: boolean }) {
  return <p role={error ? "alert" : "status"} className={error ? "mt-3 text-sm text-red-700" : "mt-3 text-sm text-[var(--brand-dark)]"}>{message}</p>;
}

function DeviceCard({ device, productLabel }: { device: Device; productLabel?: string }) {
  return <article className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">{productLabel ?? "Registered device"}</h3><p className="mt-1 break-all text-xs text-[var(--muted)]">Record ID: {device.id}</p></div>
      <span className="rounded-full bg-[#edf4f0] px-3 py-1 text-xs font-semibold">{device.state}</span>
    </div>
    <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-[var(--muted)]">Classification</dt><dd>{device.kind}</dd></div>
      <div><dt className="text-[var(--muted)]">Product reference</dt><dd className="break-all">{device.productDefinitionId}</dd></div>
      {device.householdId && <div><dt className="text-[var(--muted)]">Household</dt><dd className="break-all">{device.householdId}</dd></div>}
      {device.installationId && <div><dt className="text-[var(--muted)]">Installation</dt><dd className="break-all">{device.installationId}</dd></div>}
    </dl>
  </article>;
}

export function CustomerDeviceRegistry() {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [products, setProducts] = useState<Record<string, Product>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const homes = await api<Household[]>("/api/customer/households");
        const lists = await Promise.all(homes.map((home) => api<Device[]>(`/api/customer/households/${encodeURIComponent(home.id)}/devices`)));
        const joined = lists.flat();
        const details = await Promise.all(joined.map((device) => api<Device & { product?: Product }>(`/api/devices/${encodeURIComponent(device.id)}`)));
        if (!cancelled) {
          setHouseholds(homes);
          setDevices(joined);
          setProducts(Object.fromEntries(details.filter((item) => item.product).map((item) => [item.productDefinitionId, item.product!])));
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load household devices."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  return <RegistryFrame eyebrow="Customer devices" title="Devices in your home" description="Registry information for households where your account is an authorised member.">
    {!error && (loading || households.length > 0) && <section className="mb-8" aria-labelledby="customer-households-heading">
      <h2 id="customer-households-heading" className="mb-3 text-lg font-semibold">Your households</h2>
      {loading ? <p role="status">Loading household information…</p> : <ul className="grid gap-3 sm:grid-cols-2">
        {households.map((household) => <li key={household.id} className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h3 className="font-semibold">{household.displayName ?? "Home"}</h3>
          <p className="mt-1 break-all text-xs text-[var(--muted)]">Household ID: {household.id}</p>
        </li>)}
      </ul>}
    </section>}
    {loading ? <p role="status">Loading household devices…</p> : error ? <Status error message={error} /> : devices.length === 0 ? <Empty text={households.length ? "No devices are registered to your households yet." : "No authorised household is available to this account."} /> :
      <div className="grid gap-4 md:grid-cols-2">{devices.map((device) => <DeviceCard key={`${device.id}-${device.householdId}`} device={device} productLabel={products[device.productDefinitionId]?.displayName ?? products[device.productDefinitionId]?.productCode} />)}</div>}
  </RegistryFrame>;
}

export function InstallerDeviceRegistry() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assigned = await api<Installation[]>("/api/installer/installations");
        const lists = await Promise.all(assigned.map((installation) => api<Device[]>(`/api/installer/installations/${encodeURIComponent(installation.id)}/devices`)));
        if (!cancelled) { setInstallations(assigned); setDevices(lists.flat()); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load assigned installation devices."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  return <RegistryFrame eyebrow="Assigned installation devices" title="Devices in your assigned work" description="Read-only registry details are limited to installations assigned to your account.">
    {!error && (loading || installations.length > 0) && <section className="mb-8" aria-labelledby="installer-installations-heading">
      <h2 id="installer-installations-heading" className="mb-3 text-lg font-semibold">Assigned installations</h2>
      {loading ? <p role="status">Loading assigned installations…</p> : <ul className="grid gap-3 sm:grid-cols-2">
        {installations.map((installation) => <li key={installation.id} className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h3 className="font-semibold">Installation</h3>
          <p className="mt-1 break-all text-xs text-[var(--muted)]">Installation ID: {installation.id}</p>
          <p className="mt-2 text-sm">Status: {installation.state}</p>
        </li>)}
      </ul>}
    </section>}
    {loading ? <p role="status">Loading assigned devices…</p> : error ? <Status error message={error} /> : devices.length === 0 ? <Empty text={installations.length ? "No devices are associated with your assigned installations." : "You have no assigned installations."} /> :
      <div className="grid gap-4 md:grid-cols-2">{devices.map((device) => <DeviceCard key={device.id} device={device} />)}</div>}
  </RegistryFrame>;
}

export function SuperAdminDeviceRegistry() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState("");
  const [kind, setKind] = useState<"simulated" | "physical">("simulated");
  const reload = useCallback(async () => {
    const [records, catalogue] = await Promise.all([api<Device[]>("/api/admin/devices"), api<Product[]>("/api/admin/products")]);
    setDevices(records);
    setProducts(catalogue);
    setProductId((current) => current || catalogue.find((product) => product.state === "active")?.id || "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api<Device[]>("/api/admin/devices"), api<Product[]>("/api/admin/products")])
      .then(([records, catalogue]) => { if (!cancelled) { setDevices(records); setProducts(catalogue); setProductId(catalogue.find((product) => product.state === "active")?.id ?? ""); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load registry."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const activeProducts = products.filter((product) => product.state === "active");
  const visibleDevices = useMemo(() => devices.filter((device) => `${device.id} ${device.productDefinitionId} ${device.householdId ?? ""} ${device.installationId ?? ""}`.toLowerCase().includes(query.toLowerCase())), [devices, query]);

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    try {
      if (!productId) throw new Error("An active product definition is required.");
      const created = await api<Device>("/api/admin/devices", { method: "POST", body: JSON.stringify({ productDefinitionId: productId, kind }) });
      setNotice(`Registry record ${created.id} was created.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Registration failed."); }
  }

  async function associate(event: React.FormEvent<HTMLFormElement>, deviceId: string) {
    event.preventDefault(); setError(""); setNotice("");
    if (!window.confirm("Save these device associations? Conflicting households will be rejected.")) return;
    const form = new FormData(event.currentTarget);
    const body = { householdId: String(form.get("householdId") ?? "").trim(), installationId: String(form.get("installationId") ?? "").trim() };
    const target = Object.fromEntries(Object.entries(body).filter(([, value]) => value.length > 0));
    try {
      await api(`/api/admin/devices/${encodeURIComponent(deviceId)}/assignment`, { method: "POST", body: JSON.stringify(target) });
      setNotice(`Associations updated for ${deviceId}.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Association failed."); }
  }

  async function changeProduct(event: React.FormEvent<HTMLFormElement>, deviceId: string) {
    event.preventDefault(); setError(""); setNotice("");
    if (!window.confirm("Change the product definition associated with this device record?")) return;
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/devices/${encodeURIComponent(deviceId)}/product`, { method: "PATCH", body: JSON.stringify({ productDefinitionId: form.get("productDefinitionId") }) });
      setNotice(`Product association updated for ${deviceId}.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Product association failed."); }
  }

  return <RegistryFrame eyebrow="Platform device registry" title="Device records" description="Manage software registry records and metadata. These records do not report physical connectivity or enable appliance control.">
    <section className="mb-8 rounded-2xl border border-[var(--line)] bg-white p-5 sm:p-6" aria-labelledby="register-device-heading">
      <h2 id="register-device-heading" className="text-lg font-semibold">Register a device record</h2>
      <form onSubmit={register} className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium">Active product definition
          <select required value={productId} onChange={(event) => setProductId(event.target.value)} className={inputClass}>
            <option value="">Select a product</option>{activeProducts.map((product) => <option key={product.id} value={product.id}>{product.displayName ?? product.productCode ?? product.id}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Record classification
          <select value={kind} onChange={(event) => setKind(event.target.value as "simulated" | "physical")} className={inputClass}>
            <option value="simulated">Simulated</option><option value="physical">Physical record</option>
          </select>
        </label>
        <button className={buttonClass} type="submit" disabled={!activeProducts.length}>Create record</button>
      </form>
      <p className="mt-3 text-xs text-[var(--muted)]">The generated ID identifies this software record only; no hardware identity or connectivity is established.</p>
    </section>

    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h2 className="text-lg font-semibold">Registered records</h2><p className="text-sm text-[var(--muted)]">{devices.length} total records</p></div>
      <label className="grid gap-1.5 text-sm font-medium">Search IDs and associations
        <input className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} type="search" />
      </label>
    </div>
    {loading ? <p role="status">Loading device registry…</p> : error && devices.length === 0 ? <Status error message={error} /> : visibleDevices.length === 0 ? <Empty text={devices.length ? "No records match this search." : "No devices are registered yet."} /> :
      <div className="grid gap-4">{visibleDevices.map((device) => <article key={device.id} className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-sm">
        <DeviceCard device={device} productLabel={products.find((product) => product.id === device.productDefinitionId)?.displayName} />
        {device.state !== "retired" && <div className="mt-5 grid gap-5 border-t border-[var(--line)] pt-5 lg:grid-cols-2">
          <form onSubmit={(event) => associate(event, device.id)} className="grid gap-3" aria-label={`Associate device ${device.id}`}>
            <h3 className="font-semibold">Household and installation association</h3>
            <label className="grid gap-1 text-sm">Household ID<input name="householdId" className={inputClass} defaultValue={device.householdId ?? ""} /></label>
            <label className="grid gap-1 text-sm">Installation ID<input name="installationId" className={inputClass} defaultValue={device.installationId ?? ""} /></label>
            <p className="text-xs text-[var(--muted)]">If both are set, the installation must reference this same household. Cross-household transfers are rejected.</p>
            <button type="submit" className={buttonClass}>Save associations</button>
          </form>
          <form onSubmit={(event) => changeProduct(event, device.id)} className="grid content-start gap-3" aria-label={`Change product for ${device.id}`}>
            <h3 className="font-semibold">Product association</h3>
            <label className="grid gap-1 text-sm">Active product definition
              <select name="productDefinitionId" defaultValue={device.productDefinitionId} className={inputClass} required>
                {activeProducts.map((product) => <option key={product.id} value={product.id}>{product.displayName ?? product.productCode ?? product.id}</option>)}
              </select>
            </label>
            <button type="submit" className={buttonClass} disabled={!activeProducts.length}>Update product</button>
          </form>
        </div>}
      </article>)}</div>}
    {error && devices.length > 0 && <Status error message={error} />}
    {notice && <Status message={notice} />}
  </RegistryFrame>;
}

function RegistryFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return <main className="min-h-screen"><header className="border-b border-[var(--line)] bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8"><div><Link href="/" className="text-sm font-bold tracking-tight text-[var(--brand-dark)]">HomeGrid</Link><span className="ml-3 hidden text-sm text-[var(--muted)] sm:inline">Smart living. Reliable by design.</span></div><SignOutButton /></div></header>
    <section className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand)]">{eyebrow}</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">{description}</p><div className="mt-8">{children}</div></section>
  </main>;
}

function Empty({ text }: { text: string }) { return <div className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-8 text-sm text-[var(--muted)]">{text}</div>; }

const inputClass = "min-h-11 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[#18765f33]";
const buttonClass = "min-h-11 rounded-xl bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50";
