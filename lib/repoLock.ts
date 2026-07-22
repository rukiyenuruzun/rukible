/**
 * Proje başına basit sıraya sokma kilidi.
 *
 * Aynı projeye ait klonlama ve araçlı düzenleme aynı anda çalışıp çalışma
 * klasörünü bozmasın diye işlemleri projectId'ye göre seri hale getirir.
 * (Tek süreç içi; yerel araç için yeterli.)
 */
const chains = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  // Zincir hatada kırılmasın diye yakalanmış halini sakla.
  chains.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}
