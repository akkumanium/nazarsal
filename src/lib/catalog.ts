export const CATEGORY_IDS = ["coffee", "food", "museum", "gallery", "park", "children", "library", "culture", "sights", "viewpoint", "sport", "mall"] as const;
export type CategoryId = typeof CATEGORY_IDS[number];
export type TagRule = readonly [key: string, ...values: string[]];
export const CATEGORIES: Record<CategoryId, { label: string; singular: string; icon: string; color: string; rules: TagRule[]; visit: [number, number]; action: string }> = {
  coffee: { label: "Кофе", singular: "Кафе", icon: "coffee", color: "#b87852", rules: [["amenity", "cafe"]], visit: [15, 30], action: "Сделайте остановку на кофе и немного отдохните." },
  food: { label: "Еда", singular: "Место для еды", icon: "utensils", color: "#d8953f", rules: [["amenity", "restaurant", "fast_food", "food_court"]], visit: [25, 50], action: "Остановитесь перекусить; меню и цены уточните на месте." },
  museum: { label: "Музеи", singular: "Музей", icon: "landmark", color: "#796bb0", rules: [["tourism", "museum"]], visit: [45, 90], action: "Выделите время на осмотр экспозиции; условия посещения уточните у музея." },
  gallery: { label: "Галереи", singular: "Галерея", icon: "image", color: "#a4759b", rules: [["tourism", "gallery"]], visit: [45, 90], action: "Посмотрите выставленные работы в удобном темпе." },
  park: { label: "Парки", singular: "Парк или сад", icon: "trees", color: "#43856a", rules: [["leisure", "park", "garden"]], visit: [15, 40], action: "Пройдитесь по доступным дорожкам и сделайте паузу для отдыха." },
  children: { label: "С детьми", singular: "Детская активность", icon: "baby", color: "#d9a146", rules: [["leisure", "playground", "trampoline_park"], ["tourism", "zoo", "aquarium"]], visit: [20, 40], action: "Выберите доступную активность по возрасту ребёнка и оставайтесь рядом." },
  library: { label: "Библиотеки", singular: "Библиотека", icon: "book-open", color: "#6482aa", rules: [["amenity", "library"]], visit: [20, 60], action: "Уточните правила входа и проведите время за чтением." },
  culture: { label: "Культура", singular: "Культурное пространство", icon: "drama", color: "#bd7283", rules: [["amenity", "theatre", "cinema", "arts_centre"]], visit: [20, 40], action: "Осмотрите пространство и уточните текущую программу; билет на сеанс в расчёт не включён." },
  sights: { label: "Достопримечательности", singular: "Достопримечательность", icon: "camera", color: "#b7955a", rules: [["tourism", "attraction", "artwork"], ["historic", "monument", "memorial"]], visit: [10, 20], action: "Осмотрите объект с общедоступной территории и обратите внимание на детали." },
  viewpoint: { label: "Виды города", singular: "Смотровая точка", icon: "binoculars", color: "#5c9b9b", rules: [["tourism", "viewpoint"]], visit: [10, 20], action: "Посмотрите на панораму с доступной площадки." },
  sport: { label: "Активный отдых", singular: "Спортивный объект", icon: "activity", color: "#6a9a70", rules: [["leisure", "sports_centre", "fitness_station", "ice_rink"]], visit: [20, 45], action: "Уточните доступ и выберите подходящую вам лёгкую активность." },
  mall: { label: "Торговые центры", singular: "Торговый центр", icon: "shopping-bag", color: "#9b8e80", rules: [["shop", "mall"]], visit: [20, 40], action: "Пройдитесь по общедоступным пространствам центра." }
};

export const FEATURE_IDS = ["power_outlets", "wifi", "wheelchair", "free_entry", "indoor", "open_now", "quiet", "child_friendly"] as const;
export type FeatureId = typeof FEATURE_IDS[number];
export const FEATURE_LABELS: Record<FeatureId, string> = {
  power_outlets: "Розетки", wifi: "Wi-Fi", wheelchair: "Доступность для коляски", free_entry: "Бесплатный вход", indoor: "В помещении", open_now: "Открыто по расписанию", quiet: "Тихое место", child_friendly: "Подходит детям"
};
export function categoryIdsForTags(tags: Record<string, string>): CategoryId[] {
  return CATEGORY_IDS.filter(id => CATEGORIES[id].rules.some(([key, ...values]) => values.includes(tags[key])));
}
export function poiSelectors(bbox: string): string {
  const rules = [...new Set(CATEGORY_IDS.flatMap(id => CATEGORIES[id].rules.map(([key, ...values]) =>
    `nwr["${key}"~"^(${values.join("|")})$"](${bbox});`)))];
  return rules.join("\n");
}
export const CATEGORY_PROMPT = CATEGORY_IDS.map(id => `${id}: ${CATEGORIES[id].label}`).join("; ");
