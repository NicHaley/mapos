/**
 * Normalized POI category vocabulary + searchable synonyms.
 *
 * Keyed by the raw OSM "key:value" that build-geocode's classify() produces for
 * kind=poi features (e.g. "amenity:restaurant"). `category` is the stable id
 * stored in features.category and used for structured filtering by the app;
 * `synonyms` is a space-joined term blob indexed in FTS5 (features.category_terms)
 * so free-text queries like "restaurants" or "coffee" match by category.
 *
 * Synonyms include plural forms explicitly — the FTS tokenizer (unicode61) does
 * no stemming, and prefix matching only helps when the QUERY is a prefix of the
 * stored term, not the reverse ("restaurants" would not match a stored
 * "restaurant").
 *
 * Unmapped values fall back to the raw value with underscores as spaces (plus
 * the tag key), so e.g. shop:greengrocer stays findable as "greengrocer".
 */

export type CategoryEntry = { category: string; synonyms: string };

export const CATEGORY_MAP: Record<string, CategoryEntry> = {
  // --- food & drink (amenity) ---
  "amenity:restaurant": {
    category: "restaurant",
    synonyms: "restaurant restaurants dining eatery food"
  },
  "amenity:cafe": { category: "cafe", synonyms: "cafe cafes coffee coffeeshop espresso" },
  "amenity:fast_food": { category: "fast_food", synonyms: "fast food fastfood takeaway takeout" },
  "amenity:bar": { category: "bar", synonyms: "bar bars drinks cocktails nightlife" },
  "amenity:pub": { category: "pub", synonyms: "pub pubs bar beer" },
  "amenity:biergarten": { category: "pub", synonyms: "biergarten beer garden pub" },
  "amenity:food_court": { category: "food_court", synonyms: "food court foodcourt" },
  "amenity:ice_cream": { category: "ice_cream", synonyms: "ice cream icecream gelato dessert" },
  "amenity:nightclub": {
    category: "nightclub",
    synonyms: "nightclub nightclubs club clubs nightlife"
  },

  // --- everyday services (amenity) ---
  "amenity:bank": { category: "bank", synonyms: "bank banks" },
  "amenity:atm": { category: "atm", synonyms: "atm atms cash machine" },
  "amenity:pharmacy": { category: "pharmacy", synonyms: "pharmacy pharmacies chemist drugstore" },
  "amenity:hospital": { category: "hospital", synonyms: "hospital hospitals emergency" },
  "amenity:clinic": { category: "clinic", synonyms: "clinic clinics doctor medical" },
  "amenity:doctors": { category: "clinic", synonyms: "doctor doctors clinic medical" },
  "amenity:dentist": { category: "dentist", synonyms: "dentist dentists dental" },
  "amenity:veterinary": { category: "veterinary", synonyms: "veterinary vet vets animal" },
  "amenity:post_office": { category: "post_office", synonyms: "post office mail postal" },
  "amenity:police": { category: "police", synonyms: "police station" },
  "amenity:fire_station": { category: "fire_station", synonyms: "fire station firefighters" },
  "amenity:townhall": { category: "townhall", synonyms: "town hall townhall city hall" },
  "amenity:courthouse": { category: "courthouse", synonyms: "courthouse court" },
  "amenity:embassy": { category: "embassy", synonyms: "embassy embassies consulate" },
  "amenity:library": { category: "library", synonyms: "library libraries books" },
  "amenity:school": { category: "school", synonyms: "school schools" },
  "amenity:kindergarten": {
    category: "kindergarten",
    synonyms: "kindergarten daycare nursery preschool"
  },
  "amenity:college": { category: "college", synonyms: "college colleges" },
  "amenity:university": { category: "university", synonyms: "university universities campus" },
  "amenity:place_of_worship": {
    category: "place_of_worship",
    synonyms: "church temple mosque synagogue worship"
  },
  "amenity:cinema": { category: "cinema", synonyms: "cinema cinemas movie theater theatre movies" },
  "amenity:theatre": { category: "theatre", synonyms: "theatre theater performing arts" },
  "amenity:marketplace": { category: "marketplace", synonyms: "market marketplace bazaar" },
  "amenity:toilets": {
    category: "toilets",
    synonyms: "toilet toilets restroom washroom bathroom wc"
  },
  "amenity:drinking_water": { category: "drinking_water", synonyms: "drinking water fountain tap" },

  // --- transport (amenity) ---
  "amenity:fuel": { category: "fuel", synonyms: "fuel gas station stations petrol gasoline" },
  "amenity:charging_station": {
    category: "charging_station",
    synonyms: "charging station ev electric charger"
  },
  "amenity:parking": { category: "parking", synonyms: "parking lot carpark garage" },
  "amenity:bicycle_parking": { category: "bicycle_parking", synonyms: "bicycle bike parking" },
  "amenity:bicycle_rental": {
    category: "bicycle_rental",
    synonyms: "bicycle bike rental bikeshare"
  },
  "amenity:car_rental": { category: "car_rental", synonyms: "car rental hire" },
  "amenity:taxi": { category: "taxi", synonyms: "taxi taxis cab" },
  "amenity:bus_station": { category: "bus_station", synonyms: "bus station terminal" },
  "amenity:ferry_terminal": { category: "ferry_terminal", synonyms: "ferry terminal boat" },

  // --- shops ---
  "shop:supermarket": {
    category: "supermarket",
    synonyms: "supermarket supermarkets grocery groceries market"
  },
  "shop:convenience": {
    category: "convenience",
    synonyms: "convenience store corner shop groceries"
  },
  "shop:bakery": { category: "bakery", synonyms: "bakery bakeries bread pastry" },
  "shop:butcher": { category: "butcher", synonyms: "butcher butchers meat" },
  "shop:greengrocer": { category: "greengrocer", synonyms: "greengrocer produce vegetables fruit" },
  "shop:seafood": { category: "seafood", synonyms: "seafood fish fishmonger" },
  "shop:deli": { category: "deli", synonyms: "deli delicatessen" },
  "shop:alcohol": { category: "alcohol", synonyms: "alcohol liquor wine spirits bottle shop" },
  "shop:wine": { category: "alcohol", synonyms: "wine alcohol liquor" },
  "shop:coffee": { category: "coffee_shop", synonyms: "coffee beans roaster" },
  "shop:tea": { category: "tea_shop", synonyms: "tea teas" },
  "shop:chocolate": { category: "chocolate", synonyms: "chocolate chocolatier sweets" },
  "shop:confectionery": { category: "confectionery", synonyms: "confectionery sweets candy" },
  "shop:clothes": { category: "clothing", synonyms: "clothing clothes apparel fashion boutique" },
  "shop:shoes": { category: "shoes", synonyms: "shoes shoe footwear" },
  "shop:jewelry": { category: "jewelry", synonyms: "jewelry jewellery jeweler" },
  "shop:bag": { category: "bags", synonyms: "bag bags luggage" },
  "shop:department_store": { category: "department_store", synonyms: "department store" },
  "shop:mall": { category: "mall", synonyms: "mall malls shopping centre center" },
  "shop:electronics": { category: "electronics", synonyms: "electronics gadgets" },
  "shop:mobile_phone": { category: "mobile_phone", synonyms: "mobile phone phones cell" },
  "shop:computer": { category: "computer", synonyms: "computer computers laptop" },
  "shop:books": { category: "books", synonyms: "book books bookstore bookshop" },
  "shop:stationery": { category: "stationery", synonyms: "stationery office supplies" },
  "shop:gift": { category: "gift", synonyms: "gift gifts souvenir souvenirs" },
  "shop:florist": { category: "florist", synonyms: "florist flowers" },
  "shop:furniture": { category: "furniture", synonyms: "furniture home" },
  "shop:hardware": { category: "hardware", synonyms: "hardware tools" },
  "shop:doityourself": { category: "hardware", synonyms: "diy hardware home improvement" },
  "shop:garden_centre": {
    category: "garden_centre",
    synonyms: "garden centre center plants nursery"
  },
  "shop:pet": { category: "pet", synonyms: "pet pets petshop" },
  "shop:toys": { category: "toys", synonyms: "toy toys" },
  "shop:sports": { category: "sports_shop", synonyms: "sports sporting goods outdoor" },
  "shop:bicycle": { category: "bicycle_shop", synonyms: "bicycle bike shop cycling" },
  "shop:car": { category: "car_dealer", synonyms: "car dealer dealership cars" },
  "shop:car_repair": { category: "car_repair", synonyms: "car repair mechanic garage auto" },
  "shop:hairdresser": { category: "hairdresser", synonyms: "hairdresser hair salon barber" },
  "shop:beauty": { category: "beauty", synonyms: "beauty salon spa nails" },
  "shop:optician": { category: "optician", synonyms: "optician glasses eyewear optometrist" },
  "shop:laundry": { category: "laundry", synonyms: "laundry laundromat dry cleaning" },
  "shop:dry_cleaning": { category: "laundry", synonyms: "dry cleaning laundry" },
  "shop:travel_agency": { category: "travel_agency", synonyms: "travel agency agent" },
  "shop:kiosk": { category: "kiosk", synonyms: "kiosk newsstand" },
  "shop:music": { category: "music_shop", synonyms: "music records vinyl instruments" },
  "shop:art": { category: "art_shop", synonyms: "art gallery supplies" },
  "shop:antiques": { category: "antiques", synonyms: "antique antiques vintage" },
  "shop:second_hand": { category: "second_hand", synonyms: "second hand secondhand thrift used" },
  "shop:charity": { category: "second_hand", synonyms: "charity thrift secondhand" },

  // --- tourism ---
  "tourism:hotel": { category: "hotel", synonyms: "hotel hotels accommodation lodging stay" },
  "tourism:hostel": { category: "hostel", synonyms: "hostel hostels accommodation budget" },
  "tourism:motel": { category: "motel", synonyms: "motel motels accommodation" },
  "tourism:guest_house": {
    category: "guest_house",
    synonyms: "guest house guesthouse bnb bed breakfast"
  },
  "tourism:apartment": { category: "apartment", synonyms: "apartment rental accommodation" },
  "tourism:camp_site": { category: "camp_site", synonyms: "campsite camping campground" },
  "tourism:caravan_site": { category: "caravan_site", synonyms: "caravan rv campground" },
  "tourism:attraction": {
    category: "attraction",
    synonyms: "attraction attractions sight sights landmark"
  },
  "tourism:museum": { category: "museum", synonyms: "museum museums exhibit" },
  "tourism:gallery": { category: "gallery", synonyms: "gallery galleries art" },
  "tourism:viewpoint": { category: "viewpoint", synonyms: "viewpoint lookout vista scenic view" },
  "tourism:information": {
    category: "tourist_information",
    synonyms: "tourist information visitor centre center"
  },
  "tourism:artwork": { category: "artwork", synonyms: "artwork sculpture public art" },
  "tourism:zoo": { category: "zoo", synonyms: "zoo zoos animals" },
  "tourism:aquarium": { category: "aquarium", synonyms: "aquarium aquariums" },
  "tourism:theme_park": { category: "theme_park", synonyms: "theme park amusement rides" },
  "tourism:picnic_site": { category: "picnic_site", synonyms: "picnic site area" },

  // --- leisure ---
  "leisure:park": { category: "park", synonyms: "park parks green space greenspace" },
  "leisure:garden": { category: "garden", synonyms: "garden gardens botanical" },
  "leisure:playground": { category: "playground", synonyms: "playground playgrounds kids" },
  "leisure:dog_park": { category: "dog_park", synonyms: "dog park dogs off leash" },
  "leisure:sports_centre": {
    category: "sports_centre",
    synonyms: "sports centre center recreation"
  },
  "leisure:fitness_centre": { category: "gym", synonyms: "gym gyms fitness workout" },
  "leisure:fitness_station": { category: "gym", synonyms: "fitness station outdoor gym" },
  "leisure:swimming_pool": { category: "swimming_pool", synonyms: "swimming pool pools swim" },
  "leisure:beach_resort": { category: "beach", synonyms: "beach resort swimming" },
  "leisure:marina": { category: "marina", synonyms: "marina harbour harbor boats" },
  "leisure:stadium": { category: "stadium", synonyms: "stadium stadiums arena" },
  "leisure:pitch": { category: "pitch", synonyms: "pitch field court sports" },
  "leisure:golf_course": { category: "golf_course", synonyms: "golf course" },
  "leisure:ice_rink": { category: "ice_rink", synonyms: "ice rink skating" },
  "leisure:bowling_alley": { category: "bowling", synonyms: "bowling alley" },
  "leisure:nature_reserve": {
    category: "nature_reserve",
    synonyms: "nature reserve conservation wildlife"
  },

  // --- historic ---
  "historic:castle": { category: "castle", synonyms: "castle castles fortress historic" },
  "historic:monument": { category: "monument", synonyms: "monument monuments memorial historic" },
  "historic:memorial": { category: "memorial", synonyms: "memorial memorials monument historic" },
  "historic:ruins": { category: "ruins", synonyms: "ruins historic archaeological" },
  "historic:archaeological_site": {
    category: "archaeological_site",
    synonyms: "archaeological site ruins historic"
  },
  "historic:fort": { category: "fort", synonyms: "fort fortress historic" },
  "historic:church": { category: "historic_church", synonyms: "church historic chapel" }
};

// Wildcard fallbacks per tag key, applied before the generic raw-value fallback.
// `office:*` POIs are rarely searched by their specific value ("office:estate_agent"),
// so a generic "office" term keeps them findable as a family.
const KEY_FALLBACKS: Record<string, CategoryEntry> = {
  office: { category: "office", synonyms: "office offices" },
  historic: { category: "historic", synonyms: "historic heritage landmark" }
};

/**
 * Resolve a raw "key:value" cls (as produced by classify()) to a normalized
 * category + synonym blob. Never returns null — unmapped values fall back to the
 * raw value so every POI stays category-searchable by its literal tag.
 */
export function resolveCategory(cls: string): CategoryEntry {
  const hit = CATEGORY_MAP[cls];
  if (hit) return hit;
  const sep = cls.indexOf(":");
  const key = sep >= 0 ? cls.slice(0, sep) : cls;
  const value = sep >= 0 ? cls.slice(sep + 1) : "";
  const keyHit = KEY_FALLBACKS[key];
  if (keyHit && value) {
    // Keep the specific value searchable alongside the family terms.
    return { category: value, synonyms: `${value.replace(/_/g, " ")} ${keyHit.synonyms}` };
  }
  if (keyHit) return keyHit;
  const human = (value || key).replace(/_/g, " ");
  return { category: value || key, synonyms: `${human} ${key}`.trim() };
}
