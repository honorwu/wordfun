export function StatusScreen({ title, detail }: { title: string; detail: string }) {
  return <main className="status-screen"><span className="brand-mark">字</span><h1>{title}</h1><p>{detail}</p></main>;
}
