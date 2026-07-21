import { REASONING_EFFORT, REASONING_EFFORT_HARD } from "./config";

/**
 * İSTEK YORUMLAMA — düşünme seviyesini isteğe göre seçer.
 *
 * Model her istekte aynı çabayı harcamak zorunda değil. Net ve mekanik bir
 * istek ("başlığı sil", "butonu koyu gri yap") taban seviyede hızlıca çözülür.
 * Ama öznel/belirsiz bir istek ("biraz canlandır", "sıkıcı olmuş", "toparla")
 * modelin önce NE istendiğini yorumlamasını gerektirir; burada bir seviye
 * yukarı çıkmak anlama isabetini belirgin artırır. Düzenlemede çıktı zaten
 * minik olduğu için ek maliyet küçüktür.
 */

/**
 * Öznel / yoruma açık kalite istekleri. Somut bir hedef (hangi öğe, hangi
 * değer) yok; "daha iyi yap" demenin türevleri. Türkçe küçük harfe çevrilmiş
 * metinde aranır.
 */
const VAGUE =
  /(güzelleştir|güzel yap|daha güzel|canlandır|hareketlendir|iyileştir|daha iyi|geliştir|toparla|elden geçir|modernleştir|modern yap|profesyonel|havalı|şık yap|şıklaştır|sıkıcı|olmamış|beğenmedim|çirkin|kötü durmuş|kötü olmuş|göze hitap|dikkat çek|çekici|etkileyici|boş durmuş|boş kalmış|eksik kalmış|zenginleştir|canlı dur)/;

/**
 * Kararsızlık / fikir sorma — kullanıcı ne istediğini kendisi de netleştirmemiş.
 */
const OPEN_ENDED = /(ne yapsak|nasıl daha|öner|fikrin|sence|sen karar|bilmiyorum)/;

/**
 * Gözlem/şikayet ifadeleri: emir yok ama örtük bir "şunu düzelt" var
 * ("başlıklar çok büyük", "burası boş duruyor", "fazla sıkışık"). Modelin önce
 * neyin sorun olduğunu ve ne kadar düzelteceğini yorumlaması gerekir.
 */
const OBSERVATION =
  /(çok|fazla|aşırı|gereğinden|baya|epey) (büyük|küçük|uzun|kısa|geniş|dar|kalın|ince|koyu|açık|renkli|sade|boş|dolu|sıkışık|dağınık|yakın|uzak)|(boş duruyor|boş kalmış|boş görünüyor|sıkışık|dağınık|göze batıyor|orantısız|dengesiz|birbirine girmiş)/;

/** Yaklaşık kelime sayısı. */
function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Bu istek "derin düşünme" gerektiriyor mu?
 * - Öznel/belirsiz kelimeler içeriyorsa,
 * - Ya da uzun ve çok parçalıysa (birden fazla ayrı iş).
 */
export function needsDeepReasoning(text: string): boolean {
  const t = text.toLocaleLowerCase("tr-TR");
  if (VAGUE.test(t) || OPEN_ENDED.test(t) || OBSERVATION.test(t)) return true;

  // Güçlü çoklu-görev sinyalleri: tek başına "birden fazla iş" demek.
  const strongMultiTask = /(\bayrıca\b| bir de |aynı zamanda|bunun yanında|hem .* hem )/;
  if (strongMultiTask.test(t)) return true;

  // Zayıf sinyaller (virgül, "ve"): ancak istek uzunsa çoklu-görev sayılır;
  // "başlığı sil ve logoyu büyüt" gibi kısa somut isteklerde taban seviye kalsın.
  const words = wordCount(t);
  return words > 14 && /(,|;| ve | sonra )/.test(t);
}

/** İsteğe uygun düşünme seviyesini döndürür. */
export function chooseEffort(text: string): "low" | "medium" | "high" {
  return needsDeepReasoning(text) ? REASONING_EFFORT_HARD : REASONING_EFFORT;
}
