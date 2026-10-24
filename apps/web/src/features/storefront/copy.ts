export type StorefrontLocale = "en" | "de" | "fr";

const copy = {
  en: {
    language: "Language", shop: "Shop", collection: "The collection", discover: "Discover the catalog",
    explore: "Explore merchant-reviewed products and their variants.", allProducts: "All products",
    emptyTitle: "No published products here yet", emptyBody: "Check another collection or return later.",
    page: "Page", previous: "Previous", next: "Next", exploreProduct: "Explore product →",
    from: "From", chooseVariant: "Choose your variant", variant: "Variant", weight: "Weight",
    stock: "Stock availability has not been provided. This catalog preview does not accept orders.",
    unavailable: "Translation unavailable — showing English.", back: "Back to collection",
    fallback: "English fallback", footer: "Published merchant catalog · Ordering is not available in this preview.",
  },
  de: {
    language: "Sprache", shop: "Shop", collection: "Kollektion", discover: "Katalog entdecken",
    explore: "Entdecken Sie vom Händler geprüfte Produkte und Varianten.", allProducts: "Alle Produkte",
    emptyTitle: "Noch keine veröffentlichten Produkte", emptyBody: "Wählen Sie eine andere Kollektion oder schauen Sie später wieder vorbei.",
    page: "Seite", previous: "Zurück", next: "Weiter", exploreProduct: "Produkt ansehen →",
    from: "Ab", chooseVariant: "Variante auswählen", variant: "Variante", weight: "Gewicht",
    stock: "Angaben zur Verfügbarkeit liegen nicht vor. Diese Katalogvorschau nimmt keine Bestellungen an.",
    unavailable: "Übersetzung nicht verfügbar — englischer Text wird angezeigt.", back: "Zurück zur Kollektion",
    fallback: "Englische Version", footer: "Veröffentlichter Händlerkatalog · In dieser Vorschau sind keine Bestellungen möglich.",
  },
  fr: {
    language: "Langue", shop: "Boutique", collection: "Collection", discover: "Découvrir le catalogue",
    explore: "Découvrez les produits et variantes vérifiés par le marchand.", allProducts: "Tous les produits",
    emptyTitle: "Aucun produit publié pour le moment", emptyBody: "Consultez une autre collection ou revenez plus tard.",
    page: "Page", previous: "Précédent", next: "Suivant", exploreProduct: "Voir le produit →",
    from: "À partir de", chooseVariant: "Choisir une variante", variant: "Variante", weight: "Poids",
    stock: "La disponibilité n’est pas indiquée. Cet aperçu du catalogue ne permet pas de commander.",
    unavailable: "Traduction indisponible — affichage en anglais.", back: "Retour à la collection",
    fallback: "Version anglaise", footer: "Catalogue publié par le marchand · Les commandes ne sont pas disponibles dans cet aperçu.",
  },
} as const;

const categoryLabels: Record<Exclude<StorefrontLocale, "en">, Record<string, string>> = {
  de: {
    "Home & Garden > Planters": "Wohnen & Garten > Pflanzgefäße", "Home & Garden > Garden Accessories": "Wohnen & Garten > Gartenaccessoires",
    "Home & Garden > Home Accessories": "Wohnen & Garten > Wohnaccessoires", "Home & Garden > Lighting": "Wohnen & Garten > Beleuchtung",
    "Home & Garden > Furniture": "Wohnen & Garten > Möbel", "Kitchen & Dining > Cookware": "Küche & Essen > Kochgeschirr",
    "Kitchen & Dining > Tableware": "Küche & Essen > Geschirr", "Kitchen & Dining > Drinkware": "Küche & Essen > Trinkgefäße",
    "Apparel & Accessories > Tops": "Bekleidung & Accessoires > Oberteile", "Apparel & Accessories > Trousers": "Bekleidung & Accessoires > Hosen",
    "Apparel & Accessories > Footwear": "Bekleidung & Accessoires > Schuhe", "Apparel & Accessories > Bags": "Bekleidung & Accessoires > Taschen",
    "Electronics > Cables & Adapters": "Elektronik > Kabel & Adapter", "Electronics > Chargers": "Elektronik > Ladegeräte",
    "Electronics > Computer Accessories": "Elektronik > Computerzubehör", "Electronics > Phone Accessories": "Elektronik > Handy-Zubehör",
    "Beauty & Personal Care > Skin Care": "Körperpflege > Hautpflege", "Beauty & Personal Care > Hair Care": "Körperpflege > Haarpflege",
    "Sports & Outdoors > Fitness Accessories": "Sport & Outdoor > Fitnesszubehör", "Sports & Outdoors > Camping": "Sport & Outdoor > Camping",
    "Pet Supplies > Feeding": "Tierbedarf > Füttern", "Pet Supplies > Toys": "Tierbedarf > Spielzeug",
    "Office Supplies > Stationery": "Bürobedarf > Schreibwaren", "Toys & Games > Games": "Spielzeug & Spiele > Spiele",
  },
  fr: {
    "Home & Garden > Planters": "Maison & jardin > Pots et jardinières", "Home & Garden > Garden Accessories": "Maison & jardin > Accessoires de jardin",
    "Home & Garden > Home Accessories": "Maison & jardin > Accessoires pour la maison", "Home & Garden > Lighting": "Maison & jardin > Éclairage",
    "Home & Garden > Furniture": "Maison & jardin > Mobilier", "Kitchen & Dining > Cookware": "Cuisine et arts de la table > Ustensiles de cuisson",
    "Kitchen & Dining > Tableware": "Cuisine et arts de la table > Vaisselle", "Kitchen & Dining > Drinkware": "Cuisine et arts de la table > Boissons",
    "Apparel & Accessories > Tops": "Vêtements et accessoires > Hauts", "Apparel & Accessories > Trousers": "Vêtements et accessoires > Pantalons",
    "Apparel & Accessories > Footwear": "Vêtements et accessoires > Chaussures", "Apparel & Accessories > Bags": "Vêtements et accessoires > Sacs",
    "Electronics > Cables & Adapters": "Électronique > Câbles et adaptateurs", "Electronics > Chargers": "Électronique > Chargeurs",
    "Electronics > Computer Accessories": "Électronique > Accessoires informatiques", "Electronics > Phone Accessories": "Électronique > Accessoires pour téléphone",
    "Beauty & Personal Care > Skin Care": "Beauté et soins personnels > Soins de la peau", "Beauty & Personal Care > Hair Care": "Beauté et soins personnels > Soins capillaires",
    "Sports & Outdoors > Fitness Accessories": "Sports et plein air > Accessoires de fitness", "Sports & Outdoors > Camping": "Sports et plein air > Camping",
    "Pet Supplies > Feeding": "Articles pour animaux > Alimentation", "Pet Supplies > Toys": "Articles pour animaux > Jouets",
    "Office Supplies > Stationery": "Fournitures de bureau > Papeterie", "Toys & Games > Games": "Jouets et jeux > Jeux",
  },
};

export function storefrontLocale(value: unknown): StorefrontLocale {
  return value === "de" || value === "fr" ? value : "en";
}

export function storefrontCopy(value: unknown) {
  return copy[storefrontLocale(value)];
}

export function storefrontCategoryLabel(key: string, value: unknown) {
  const locale = storefrontLocale(value);
  return locale === "en" ? key : categoryLabels[locale][key] ?? key;
}
