import RepoStudio from "./RepoStudio";

/**
 * "Var olan proje" modu — klonlanan bir git reposu üstünde çalışma alanı.
 * ?p=<projectId> ile doğrudan bir proje açılabilir.
 */
export default async function RepoPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  return <RepoStudio initialProjectId={p ?? null} />;
}
