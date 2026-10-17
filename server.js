import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const allowedOrigins = [
  'https://mauiza.com',
  'https://www.mauiza.com',
  'https://mauiza-backend.onrender.com'
];

const ummAlQuraMethod = 4;
const muslimWorldLeagueMethod = 3;

function addMinutesToPrayerTime(value, minutesToAdd) {
  const [hours, minutes] = value.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const normalizedMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  return `${String(Math.floor(normalizedMinutes / 60)).padStart(2, '0')}:${String(normalizedMinutes % 60).padStart(2, '0')}`;
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    try {
      const hostname = new URL(origin).hostname;
      const isAllowed = allowedOrigins.includes(origin)
        || hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === 'mauiza.com'
        || hostname === 'www.mauiza.com'
        || hostname.endsWith('.mauiza.com')
        || hostname === 'mauiza-backend.onrender.com';

      if (isAllowed) {
        return callback(null, true);
      }

      return callback(new Error('Origin is not allowed by CORS'));
    } catch (_error) {
      return callback(new Error('Origin is not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Mauiza backend is running'
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/geocode', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ data: [] });

  const googleMapsApiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!googleMapsApiKey) {
    return res.status(503).json({ message: 'Location search is not configured. Add GOOGLE_MAPS_API_KEY on the server.' });
  }

  try {
    const result = await googlePlacesRequest('places:searchText', {
      textQuery: query,
      pageSize: 6
    }, googleMapsApiKey, 'places.id,places.displayName,places.formattedAddress,places.location');
    res.json({ data: (result.places || []).map((place) => ({
      latitude: place.location?.latitude,
      longitude: place.location?.longitude,
      city: place.displayName?.text || '',
      country: '',
      label: place.formattedAddress || place.displayName?.text || query,
      placeId: place.id
    })) });
  } catch (error) {
    console.error('Geocoding failed:', error);
    res.status(502).json({ message: `Google location search could not be loaded: ${error.message || 'Please try again.'}` });
  }
});

const halalGuidanceSource = {
  name: 'Department of Halal Certification EU — Halal Food Guidelines',
  url: 'https://halalcertification.ie/halal-food-guidelines/'
};

const halalIngredientRecords = [
  { patterns: ['pork', 'porcine', 'bacon', 'lard', 'pork fat', 'pork gelatin', 'pork gelatine', 'ham'], classification: 'Potentially Haram', reason: 'This explicitly names pork or a pork-derived ingredient, which is not halal.', guidance: 'Do not consume unless the label has been misread and the manufacturer confirms a different ingredient.' },
  { patterns: ['blood', 'blood plasma', 'blood protein'], classification: 'Potentially Haram', reason: 'Blood and blood-derived food ingredients are not halal.', guidance: 'Avoid the product and verify unclear technical names with the manufacturer.' },
  { patterns: ['wine', 'beer', 'rum', 'brandy', 'liqueur', 'ethyl alcohol', 'ethanol'], classification: 'Potentially Haram', reason: 'This names an alcoholic drink or intoxicating alcohol. Product context and residual levels can matter, so consult a trusted certifier for unusual technical uses.', guidance: 'Check the full product and certification rather than relying only on the ingredient name.' },
  { patterns: ['e120', 'carmine', 'cochineal'], classification: 'Potentially Haram', reason: 'Carmine/cochineal (E120) is a colouring obtained from cochineal insects and is not accepted by the referenced certifier.', guidance: 'Choose a product using plant or synthetic colouring, or follow the ruling of your trusted halal authority.' },
  { patterns: ['fish gelatin', 'fish gelatine'], classification: 'Generally Halal', reason: 'The gelatin source is explicitly identified as fish, which is generally an acceptable halal source.', guidance: 'Still check the complete product for other ingredients and cross-contamination.' },
  { patterns: ['vegetable glycerin', 'vegetable glycerine', 'vegetable glycerol', 'plant glycerin'], classification: 'Generally Halal', reason: 'The glycerin source is explicitly identified as vegetable-derived.', guidance: 'Check the complete product if other high-risk ingredients are present.' },
  { patterns: ['microbial rennet', 'vegetarian rennet', 'microbial enzyme', 'plant enzyme'], classification: 'Generally Halal', reason: 'The enzyme source is explicitly identified as microbial or plant-derived and is generally halal.', guidance: 'Check that the culture medium and complete product are halal-compliant when certification is important.' },
  { patterns: ['gelatin', 'gelatine', 'e441', 'collagen', 'hydrolyzed collagen'], classification: 'Requires Verification / Mushbooh', reason: 'Gelatin and collagen are animal-derived. Fish sources can be acceptable; bovine sources require halal slaughter and processing verification; porcine sources are prohibited.', guidance: 'Look for a recognised halal certificate and a declared fish or halal-slaughtered animal source.' },
  { patterns: ['mono and diglycerides', 'mono- and diglycerides', 'monoglycerides', 'diglycerides', 'e471', 'e472', 'e472a', 'e472b', 'e472c', 'e472d', 'e472e', 'e472f'], classification: 'Requires Verification / Mushbooh', reason: 'These emulsifiers can be made from plant oils or animal fats, and the ingredient name alone does not identify the source.', guidance: 'Confirm a vegetable source or recognised halal certification.' },
  { patterns: ['glycerin', 'glycerine', 'glycerol', 'e422'], classification: 'Requires Verification / Mushbooh', reason: 'Glycerin/glycerol may be plant-derived, synthetic, or animal-derived.', guidance: 'Confirm that it is vegetable/synthetic or covered by halal certification.' },
  { patterns: ['rennet', 'pepsin', 'lipase', 'enzymes', 'enzyme'], classification: 'Requires Verification / Mushbooh', reason: 'Food enzymes may be microbial, plant-derived, or animal-derived. Animal enzymes require an acceptable source and halal processing.', guidance: 'Ask for the enzyme source or a halal certificate.' },
  { patterns: ['whey', 'whey protein', 'casein', 'caseinate', 'cheese powder'], classification: 'Requires Verification / Mushbooh', reason: 'Dairy ingredients can depend on the enzymes or rennet used during cheese production.', guidance: 'Verify the rennet/enzyme source or select a halal-certified product.' },
  { patterns: ['natural flavor', 'natural flavour', 'artificial flavor', 'artificial flavour', 'flavoring', 'flavouring', 'vanilla extract'], classification: 'Requires Verification / Mushbooh', reason: 'Flavour systems can contain animal-derived carriers or alcohol that are not disclosed by the general ingredient name.', guidance: 'Request the flavour specification or rely on recognised halal certification.' },
  { patterns: ['shortening', 'animal fat', 'tallow', 'suet', 'stearic acid', 'e570', 'magnesium stearate', 'e572'], classification: 'Requires Verification / Mushbooh', reason: 'These fats or fatty-acid derivatives may come from plant or animal sources.', guidance: 'Confirm vegetable origin or halal-certified animal origin.' },
  { patterns: ['l-cysteine', 'l cysteine', 'cysteine', 'e920'], classification: 'Requires Verification / Mushbooh', reason: 'L-cysteine can be produced synthetically or obtained from animal or human-derived material.', guidance: 'Confirm a synthetic, fermentation-derived, or halal-certified source.' },
  { patterns: ['disodium inosinate', 'e631', 'disodium guanylate', 'e627', 'disodium ribonucleotides', 'e635'], classification: 'Requires Verification / Mushbooh', reason: 'These flavour enhancers may be produced by fermentation or from animal/fish material.', guidance: 'Verify the manufacturing source or halal certification.' },
  { patterns: ['e153', 'carbon black', 'vegetable carbon'], classification: 'Requires Verification / Mushbooh', reason: 'E153 can be produced from vegetable material or animal bone, so the source matters.', guidance: 'Confirm that it is vegetable carbon rather than bone-derived.' },
  { patterns: ['e160e', 'beta-apo-8-carotenal', 'apocarotenal', 'e160a', 'beta-carotene'], classification: 'Requires Verification / Mushbooh', reason: 'The colour itself can be plant/synthetic, but some preparations use gelatin or animal fat as a carrier.', guidance: 'Verify the carrier or use a halal-certified product.' },
  { patterns: ['shellac', 'e904'], classification: 'Requires Verification / Mushbooh', reason: 'Shellac is an insect-derived glazing agent, and scholarly/certifier rulings can differ.', guidance: 'Follow a trusted halal authority or choose an alternative glaze.' },
  { patterns: ['agar agar', 'agar-agar', 'e406'], classification: 'Generally Halal', reason: 'Agar is a seaweed-derived gelling agent commonly used as a plant alternative to gelatin.' },
  { patterns: ['carrageenan', 'e407'], classification: 'Generally Halal', reason: 'Carrageenan is a seaweed-derived thickener and gelling agent.' },
  { patterns: ['pectin', 'e440'], classification: 'Generally Halal', reason: 'Pectin is a plant-derived gelling ingredient.' },
  { patterns: ['xanthan gum', 'e415'], classification: 'Generally Halal', reason: 'Xanthan gum is produced by microbial fermentation and is generally halal, subject to the full formulation and processing aids.' },
  { patterns: ['cellulose gum', 'carboxymethyl cellulose', 'e466'], classification: 'Generally Halal', reason: 'Cellulose gum is a plant-derived/synthetic cellulose ingredient and is generally halal.' },
  { patterns: ['soy lecithin', 'soya lecithin', 'sunflower lecithin'], classification: 'Generally Halal', reason: 'The declared lecithin source is plant-based.' },
  { patterns: ['ascorbic acid', 'vitamin c', 'e300', 'citric acid', 'e330', 'sodium bicarbonate', 'baking soda', 'e500', 'curcumin', 'e100'], classification: 'Generally Halal', reason: 'This is generally obtained from plant, mineral, fermentation, or synthetic sources and is ordinarily halal.' },
  { patterns: ['water', 'salt', 'sugar', 'rice', 'flour', 'corn starch', 'cornstarch', 'potato starch', 'olive oil', 'sunflower oil', 'canola oil', 'palm oil', 'coconut oil'], classification: 'Generally Halal', reason: 'This is a common plant- or mineral-derived ingredient and is generally halal in its basic form.' }
];

function normalizeIngredient(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/e\s*-?\s*(\d{3,4}[a-f]?)/g, 'e$1')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasIngredientPattern(value, pattern) {
  const normalizedPattern = normalizeIngredient(pattern);
  const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(value);
}

function splitIngredientEntries(value) {
  return [...new Set(String(value || '').split(/[\n,;]+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

app.post('/api/halal/analyze', (req, res) => {
  const rawIngredients = String(req.body?.ingredients || '').trim();
  if (!rawIngredients) return res.status(400).json({ message: 'Ingredient text is required.' });
  if (rawIngredients.length > 10000) return res.status(413).json({ message: 'The ingredient list is too long. Check up to 100 ingredients at a time.' });

  const ingredientEntries = splitIngredientEntries(rawIngredients);
  if (ingredientEntries.length > 100) return res.status(413).json({ message: 'Check up to 100 ingredients at a time.' });

  const results = ingredientEntries.map((entry) => {
    const normalized = normalizeIngredient(entry);
    const inputENumber = normalized.match(/(^|[^a-z0-9])(e\d{3,4}[a-f]?)($|[^a-z0-9])/i)?.[2]?.toUpperCase();
    const matchingRecord = halalIngredientRecords.find((record) => record.patterns.some((pattern) => hasIngredientPattern(normalized, pattern)));

    if (matchingRecord) {
      const pattern = matchingRecord.patterns.find((item) => hasIngredientPattern(normalized, item));
      const eNumber = normalizeIngredient(pattern).match(/^e\d{3,4}[a-f]?$/)?.[0]?.toUpperCase();
      return {
        name: entry,
        eNumber: inputENumber || eNumber,
        classification: matchingRecord.classification,
        reason: matchingRecord.reason,
        guidance: matchingRecord.guidance || 'Check the complete product label and certification if other high-risk ingredients are present.',
        source: halalGuidanceSource.name,
        sourceUrl: halalGuidanceSource.url
      };
    }

    const eNumber = inputENumber;

    return {
      name: entry,
      eNumber,
      classification: 'Requires Verification / Mushbooh',
      reason: eNumber
        ? `${eNumber} is not yet covered by this reference set. An E-number alone does not establish whether its source and processing are halal.`
        : 'This ingredient is not yet covered by the checker, or its halal status depends on source and processing information not present in the name.',
      guidance: 'Check the manufacturer specification and a recognised halal certificate. Do not treat an unknown result as halal or haram.',
      source: halalGuidanceSource.name,
      sourceUrl: halalGuidanceSource.url
    };
  });

  const summary = results.reduce((counts, result) => {
    if (result.classification === 'Generally Halal') counts.generallyHalal += 1;
    else if (result.classification === 'Potentially Haram') counts.potentiallyHaram += 1;
    else counts.requiresVerification += 1;
    return counts;
  }, { generallyHalal: 0, requiresVerification: 0, potentiallyHaram: 0 });

  res.json({ results, summary, disclaimer: 'Ingredient screening is educational and is not a halal certification or religious ruling. Final product status also depends on sub-ingredients, processing aids, cross-contamination, and recognised certification.' });
});

app.post('/api/halal/ocr', async (req, res) => {
  const image = String(req.body?.image || '');
  if (!image.startsWith('data:image/')) return res.status(400).json({ message: 'Please upload a valid image file.' });
  if (!process.env.OCR_SPACE_API_KEY) return res.status(503).json({ message: 'Image scanning needs an OCR provider key. Add OCR_SPACE_API_KEY on the server to enable it.' });
  try {
    const body = new URLSearchParams({ base64Image: image, language: 'eng', isOverlayRequired: 'false' });
    const response = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: process.env.OCR_SPACE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const result = await response.json();
    const text = result.ParsedResults?.map((item) => item.ParsedText).join('\n').trim() || '';
    if (!response.ok || result.IsErroredOnProcessing) throw new Error(result.ErrorMessage?.join(', ') || 'OCR could not read the image.');
    res.json({ text });
  } catch (error) { res.status(502).json({ message: error.message || 'OCR service is temporarily unavailable.' }); }
});

function distanceInKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(latitudeB - latitudeA);
  const longitudeDistance = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDistance / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGoogleDurationSeconds(value) {
  const seconds = Number.parseFloat(String(value || '').replace(/s$/, ''));
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

function formatTravelTime(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

async function googlePlacesRequest(path, body, apiKey, fieldMask) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://places.googleapis.com/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask || [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.googleMapsUri',
          'places.primaryType',
          'places.types',
          'places.businessStatus',
          'places.rating',
          'places.userRatingCount',
          'routingSummaries',
          'nextPageToken'
        ].join(',')
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = payload.error?.message || `Google Places returned ${response.status}`;
      throw new Error(providerMessage);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function googleTextSearchAll(body, apiKey, maxPages = 3) {
  const pages = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await googlePlacesRequest('places:searchText', {
      ...body,
      ...(pageToken ? { pageToken } : {})
    }, apiKey);
    pages.push(payload);
    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }
  return pages;
}

async function googleTextSearchMany(searchBodies, apiKey) {
  const pageGroups = await Promise.all(searchBodies.map((body) => googleTextSearchAll(body, apiKey, 1)));
  return pageGroups.flat();
}

app.get('/api/nearby-places', async (req, res) => {
  const latitude = Number(req.query.latitude), longitude = Number(req.query.longitude), radius = Math.min(Math.max(Number(req.query.radius) || 5, 1), 25);
  const categoryInput = String(req.query.category || 'All');
  const categoryKey = categoryInput.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

  let category = 'All';
  if (['all', 'tous'].includes(categoryKey)) category = 'All';
  else if (['mosque', 'mosques', 'mosquée', 'mosquées'].includes(categoryKey)) category = 'Mosques';
  else if (['halal food', 'halal-food', 'nourriture halal'].includes(categoryKey)) category = 'Halal Food';
  else if (['islamic center', 'islamic centers', 'islamic centre', 'islamic centres', 'centres islamiques', 'centers islamiques'].includes(categoryKey)) category = 'Islamic Centers';

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ message: 'A valid search location is required.' });
  }

  const googleMapsApiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!googleMapsApiKey) {
    return res.status(503).json({
      message: 'Nearby search is not configured. Add GOOGLE_MAPS_API_KEY on the server and enable Places API (New).'
    });
  }

  try {
    const radiusMeters = radius * 1000;
    const center = { latitude, longitude };
    const routingParameters = {
      origin: center,
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE'
    };
    const textSearchBody = (textQuery, includedType, rankPreference = 'DISTANCE') => ({
      textQuery,
      ...(includedType ? { includedType, strictTypeFiltering: true } : {}),
      pageSize: 20,
      rankPreference,
      locationBias: { circle: { center, radius: radiusMeters } },
      routingParameters,
      languageCode: String(req.query.language || 'en').slice(0, 2)
    });
    const searches = {
      Mosques: () => googleTextSearchAll(textSearchBody('mosques', 'mosque'), googleMapsApiKey),
      'Halal Food': () => googleTextSearchMany([
        textSearchBody('halal restaurant', null, 'RELEVANCE'),
        textSearchBody('halal food', null, 'RELEVANCE')
      ], googleMapsApiKey),
      'Islamic Centers': () => googleTextSearchMany([
        textSearchBody('Islamic center', null, 'RELEVANCE'),
        textSearchBody('madrasa', null, 'RELEVANCE'),
        textSearchBody('Islamic institute', null, 'RELEVANCE')
      ], googleMapsApiKey)
    };
    const requestedCategories = category === 'All' ? Object.keys(searches) : [category];
    const payloads = await Promise.all(requestedCategories.map(async (requestedCategory) => ({
      requestedCategory,
      pages: await searches[requestedCategory]()
    })));

    const results = payloads.flatMap(({ requestedCategory, pages }) => pages.flatMap((payload) => (payload.places || []).map((place, index) => {
      const placeLatitude = Number(place.location?.latitude);
      const placeLongitude = Number(place.location?.longitude);
      const aerialDistanceKm = distanceInKm(latitude, longitude, placeLatitude, placeLongitude);
      const routeLeg = payload.routingSummaries?.[index]?.legs?.[0];
      const routeDistanceMeters = typeof routeLeg?.distanceMeters === 'number' ? routeLeg.distanceMeters : null;
      const travelDurationSeconds = parseGoogleDurationSeconds(routeLeg?.duration);
      const hasCompleteRoute = routeDistanceMeters != null && Number.isFinite(travelDurationSeconds);
      const resultCategory = requestedCategory === 'Mosques'
        ? 'Mosque'
        : requestedCategory === 'Islamic Centers' ? 'Islamic Center' : 'Halal Food';
      const normalizedName = String(place.displayName?.text || '').toLowerCase();
      const placeTypes = Array.isArray(place.types) ? place.types : [];
      const isFoodPlace = /halal/.test(normalizedName) || placeTypes.some((type) => (
        type.includes('restaurant')
        || type.includes('food')
        || type.includes('meal')
        || type.includes('bakery')
        || type.includes('cafe')
        || type.includes('grocery')
        || type.includes('butcher')
      ));
      const isIslamicCenter = /(islamic|muslim|markaz|madrasa|madrassa|madrasah|jamia|darul|dar al|quran|qur'an|قرآن|مدرس|اسلامی)/i.test(normalizedName);

      return {
        id: place.id,
        name: place.displayName?.text || 'Unnamed place',
        address: place.formattedAddress || 'Address unavailable',
        category: resultCategory,
        latitude: placeLatitude,
        longitude: placeLongitude,
        distanceKm: hasCompleteRoute ? Number((routeDistanceMeters / 1000).toFixed(1)) : null,
        travelDurationMinutes: hasCompleteRoute ? Math.max(1, Math.round(travelDurationSeconds / 60)) : null,
        travelTime: hasCompleteRoute ? formatTravelTime(travelDurationSeconds) : null,
        distanceType: hasCompleteRoute ? 'driving' : null,
        rating: Number.isFinite(place.rating) ? place.rating : null,
        userRatingCount: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
        businessStatus: place.businessStatus || null,
        directionsUrl: `https://www.google.com/maps/dir/?api=1&origin=${latitude},${longitude}&destination=${placeLatitude},${placeLongitude}&destination_place_id=${encodeURIComponent(place.id)}&travelmode=driving`,
        googleMapsUrl: place.googleMapsUri || null,
        aerialDistanceKm,
        matchesCategory: requestedCategory === 'Halal Food'
          ? isFoodPlace
          : requestedCategory === 'Islamic Centers' ? isIslamicCenter : true
      };
    })))
      .filter((place) => Number.isFinite(place.latitude) && Number.isFinite(place.longitude))
      .filter((place) => place.aerialDistanceKm <= radius + 0.05)
      .filter((place) => place.matchesCategory)
      .filter((place) => place.businessStatus !== 'CLOSED_PERMANENTLY');

    const uniqueResults = results
      .filter((place, index, array) => array.findIndex((item) => item.id === place.id) === index)
      .sort((a, b) => (a.distanceKm ?? a.aerialDistanceKm) - (b.distanceKm ?? b.aerialDistanceKm))
      .map(({ aerialDistanceKm: _aerialDistanceKm, matchesCategory: _matchesCategory, ...place }) => place);

    const responsePayload = {
      results: uniqueResults,
      source: 'Google Places',
      distanceSource: 'Google driving routes',
      center: { latitude, longitude },
      radiusKm: radius
    };
    return res.json(responsePayload);
  } catch (error) {
    console.error('Nearby places lookup failed:', error);
    return res.status(502).json({ message: `Google Places could not be loaded: ${error.message || 'Please try again in a moment.'}` });
  }
});

app.get('/api/prayer-times', async (req, res) => {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  const date = String(req.query.date || '').trim();
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'A valid location and date are required.' });
  }

  try {
    const [year, month, day] = date.split('-');
    const endpoint = `https://api.aladhan.com/v1/timings/${day}-${month}-${year}?latitude=${latitude}&longitude=${longitude}`;
    const [ummAlQuraResponse, muslimWorldLeagueResponse] = await Promise.all([
      fetch(`${endpoint}&method=${ummAlQuraMethod}`),
      fetch(`${endpoint}&method=${muslimWorldLeagueMethod}`)
    ]);
    if (!ummAlQuraResponse.ok || !muslimWorldLeagueResponse.ok) throw new Error('Prayer times request failed');
    const [ummAlQuraResult, muslimWorldLeagueResult] = await Promise.all([ummAlQuraResponse.json(), muslimWorldLeagueResponse.json()]);
    if (ummAlQuraResult.code !== 200 || !ummAlQuraResult.data || muslimWorldLeagueResult.code !== 200 || !muslimWorldLeagueResult.data) {
      throw new Error('Prayer times response was invalid');
    }
    const { data } = ummAlQuraResult;
    const timings = Object.fromEntries(['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib'].map((name) => [name, String(data.timings[name] || '').split(' ')[0]]));
    timings.Dhuhr = addMinutesToPrayerTime(timings.Dhuhr, 5);
    timings.Isha = String(muslimWorldLeagueResult.data.timings.Isha || '').split(' ')[0];
    const gregorian = data.date.gregorian;
    let location = {};
    try {
      const locationResponse = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`, {
        headers: { 'User-Agent': 'Mauiza-Daily-Essentials/1.0 (mauizainstitute@gmail.com)' }
      });
      const locationResult = await locationResponse.json();
      const address = locationResult.address || {};
      location = {
        city: address.city || address.town || address.village || address.county || '',
        country: address.country || ''
      };
    } catch (_error) {
      // Prayer times remain usable if reverse geocoding is unavailable.
    }
    res.json({ data: {
      timings,
      timezone: data.meta.timezone,
      method: 'Umm al-Qura, Makkah (Isha: Muslim World League)',
      date: `${gregorian.year}-${String(gregorian.month.number).padStart(2, '0')}-${String(gregorian.day).padStart(2, '0')}`,
      dateLabel: `${gregorian.weekday.en}, ${gregorian.day} ${gregorian.month.en} ${gregorian.year}`,
      hijriDate: `${data.date.hijri.day} ${data.date.hijri.month.en} ${data.date.hijri.year}`,
      location
    } });
  } catch (error) {
    console.error('Prayer timings failed:', error);
    res.status(502).json({ message: 'Prayer timings are temporarily unavailable. Please try again.' });
  }
});

const adminEmail = process.env.EMAIL_USER || 'mauizainstitute@gmail.com';
const emailPassword = (process.env.EMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

const contactSchema = new mongoose.Schema({
  name: String,
  email: String,
  subject: String,
  message: String,
  createdAt: { type: Date, default: Date.now }
});

const registrationSchema = new mongoose.Schema({
  fullName: String,
  email: String,
  phoneCountryCode: String,
  phoneNumber: String,
  phone: String,
  country: String,
  ageGroup: String,
  gender: String,
  timezone: String,
  instructionLanguage: String,
  faith: String,
  course: String,
  startTime: String,
  endTime: String,
  schedule: String,
  goals: String,
  createdAt: { type: Date, default: Date.now }
});

const volunteerSchema = new mongoose.Schema({
  fullName: String,
  email: String,
  phoneCountryCode: String,
  phoneNumber: String,
  phone: String,
  country: String,
  profession: String,
  designation: String,
  ageGroup: String,
  gender: String,
  timezone: String,
  faith: String,
  instructionLanguage: String,
  startTime: String,
  endTime: String,
  availability: String,
  availabilityDetails: String,
  goals: String,
  islamicEducation: String,
  skills: String,
  tiktokAccount: String,
  roleDetails: String,
  createdAt: { type: Date, default: Date.now }
});

const ContactMessage = mongoose.model('ContactMessage', contactSchema);
const RegistrationEntry = mongoose.model('RegistrationEntry', registrationSchema);
const VolunteerEntry = mongoose.model('VolunteerEntry', volunteerSchema);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: adminEmail,
    pass: emailPassword
  }
});

async function sendAdminMail({ subject, text, html }) {
  if (!emailPassword) {
    console.warn('Email password is missing. Skipping email send.');
    return false;
  }

  try {
    await transporter.sendMail({
      from: adminEmail,
      to: adminEmail,
      replyTo: 'mauizainstitute@gmail.com',
      subject,
      text,
      html
    });
    return true;
  } catch (error) {
    console.error('Admin email notification failed:', error.message);
    return false;
  }
}

// A form submission must not be held up by an email provider. The database is
// the source of truth; notifications are best-effort and run after the HTTP
// response has been sent to the visitor.
function notifyAdmin(mail) {
  void sendAdminMail(mail).catch((error) => {
    console.error('Admin email notification failed:', error.message);
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Mauiza backend is running' });
});

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if ([name, email, subject, message].some((value) => typeof value !== 'string' || !value.trim())) {
      return res.status(400).json({ message: 'All contact fields are required.' });
    }

    const cleanedName = name.trim();
    const cleanedEmail = email.trim();
    const cleanedSubject = subject.trim();
    const cleanedMessage = message.trim();

    const saved = await ContactMessage.create({
      name: cleanedName,
      email: cleanedEmail,
      subject: cleanedSubject,
      message: cleanedMessage
    });

    const emailText = [
      `Name: ${cleanedName}`,
      `Email: ${cleanedEmail}`,
      `Subject: ${cleanedSubject}`,
      '',
      'Message:',
      cleanedMessage
    ].join('\n');

    notifyAdmin({
      subject: `New contact message: ${cleanedSubject}`,
      text: emailText,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h3>New Contact Message</h3>
          <p><strong>Name:</strong> ${cleanedName}</p>
          <p><strong>Email:</strong> ${cleanedEmail}</p>
          <p><strong>Subject:</strong> ${cleanedSubject}</p>
          <p><strong>Message:</strong></p>
          <p>${cleanedMessage.replace(/\n/g, '<br />')}</p>
        </div>
      `
    });

    res.status(201).json({
      message: 'Your message has been sent successfully.',
      data: saved
    });
  } catch (error) {
    console.error('Contact submission failed:', error);
    res.status(500).json({ message: 'Failed to submit your message.' });
  }
});

app.post('/api/registration', async (req, res) => {
  try {
    const {
      fullName,
      email,
      phoneCountryCode,
      phoneNumber,
      phone,
      country,
      ageGroup,
      gender,
      timezone,
      instructionLanguage,
      faith,
      course,
      startTime,
      endTime,
      schedule,
      goals,
      name
    } = req.body;

    const cleanedFullName = fullName || name || '';

    if ([cleanedFullName, email, phoneCountryCode, phoneNumber, phone, country, ageGroup, gender, timezone, instructionLanguage, faith, course, startTime, endTime, goals]
      .some((value) => typeof value !== 'string' || !value.trim())) {
      return res.status(400).json({ message: 'Please complete all required registration fields.' });
    }

    const cleanedEmail = email.trim();
    const cleanedPhoneCountryCode = phoneCountryCode.trim();
    const cleanedPhoneNumber = phoneNumber.trim();
    const cleanedPhone = phone.trim();
    if (!/^\+[1-9]\d{0,2}$/.test(cleanedPhoneCountryCode)
      || !/^\+[1-9]\d{1,14}$/.test(cleanedPhone)
      || !cleanedPhone.startsWith(cleanedPhoneCountryCode)) {
      return res.status(400).json({ message: 'The phone number must match the selected country code.' });
    }
    const cleanedCountry = country.trim();
    const cleanedAgeGroup = ageGroup.trim();
    const cleanedGender = gender.trim();
    const cleanedTimezone = timezone.trim();
    const cleanedInstructionLanguage = instructionLanguage.trim();
    const cleanedFaith = faith.trim();
    const cleanedCourse = course.trim();
    const cleanedStartTime = startTime.trim();
    const cleanedEndTime = endTime.trim();
    const cleanedSchedule = schedule?.trim();
    const cleanedGoals = goals.trim();

    const saved = await RegistrationEntry.create({
      fullName: cleanedFullName,
      email: cleanedEmail,
      phoneCountryCode: cleanedPhoneCountryCode,
      phoneNumber: cleanedPhoneNumber,
      phone: cleanedPhone,
      country: cleanedCountry,
      ageGroup: cleanedAgeGroup,
      gender: cleanedGender,
      timezone: cleanedTimezone,
      instructionLanguage: cleanedInstructionLanguage,
      faith: cleanedFaith,
      course: cleanedCourse,
      startTime: cleanedStartTime,
      endTime: cleanedEndTime,
      schedule: cleanedSchedule,
      goals: cleanedGoals
    });

    const emailText = [
      `Full Name: ${cleanedFullName}`,
      `Email: ${email}`,
      `WhatsApp Country Code: ${cleanedPhoneCountryCode}`,
      `WhatsApp Local Number: ${cleanedPhoneNumber}`,
      `WhatsApp Number (international): ${cleanedPhone}`,
      `Country: ${country}`,
      `Age Group: ${ageGroup}`,
      `Gender: ${gender}`,
      `Timezone: ${cleanedTimezone}`,
      `Language of Instruction: ${cleanedInstructionLanguage}`,
      `Faith: ${cleanedFaith}`,
      `Course: ${course}`,
      `Preferred Time: ${schedule || `${startTime || 'N/A'} - ${endTime || 'N/A'}`}`,
      `Learning Goals: ${goals || 'Not provided'}`,
      '',
      'Registration details saved in MongoDB.'
    ].join('\n');

    notifyAdmin({
      subject: `New registration: ${course}`,
      text: emailText,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h3>New Registration</h3>
          <p><strong>Full Name:</strong> ${cleanedFullName}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>WhatsApp Country Code:</strong> ${cleanedPhoneCountryCode}</p>
          <p><strong>WhatsApp Local Number:</strong> ${cleanedPhoneNumber}</p>
          <p><strong>WhatsApp Number (international):</strong> ${cleanedPhone}</p>
          <p><strong>Country:</strong> ${country}</p>
          <p><strong>Age Group:</strong> ${ageGroup}</p>
          <p><strong>Gender:</strong> ${gender}</p>
          <p><strong>Timezone:</strong> ${cleanedTimezone}</p>
          <p><strong>Language of Instruction:</strong> ${cleanedInstructionLanguage}</p>
          <p><strong>Faith:</strong> ${cleanedFaith}</p>
          <p><strong>Course:</strong> ${course}</p>
          <p><strong>Preferred Time:</strong> ${schedule || `${startTime || 'N/A'} - ${endTime || 'N/A'}`}</p>
          <p><strong>Learning Goals:</strong> ${goals || 'Not provided'}</p>
        </div>
      `
    });

    res.status(201).json({
      message: 'Registration submitted successfully.',
      data: saved
    });
  } catch (error) {
    console.error('Registration failed:', error);
    res.status(500).json({ message: 'Failed to submit the registration.' });
  }
});

app.post('/api/volunteers', async (req, res) => {
  try {
    const {
      fullName,
      name,
      email,
      phoneCountryCode,
      phoneNumber,
      phone,
      country,
      profession,
      designation,
      ageGroup,
      gender,
      timezone,
      faith,
      instructionLanguage,
      startTime,
      endTime,
      availability,
      availabilityDetails,
      goals,
      islamicEducation,
      skills,
      tiktokAccount
    } = req.body;

    const cleanedFullName = (fullName || name || '').trim();
    const allowedDesignations = ['Teacher', 'Video Editor', 'Media Manager'];
    const commonFields = [cleanedFullName, email, phoneCountryCode, phoneNumber, phone, country, profession, designation, ageGroup, gender, timezone, faith, instructionLanguage, startTime, endTime, availability, goals];

    if (commonFields.some((value) => typeof value !== 'string' || !value.trim()) || !allowedDesignations.includes(designation)) {
      return res.status(400).json({ message: 'Please complete all required volunteer fields.' });
    }

    const cleanedPhoneCountryCode = phoneCountryCode.trim();
    const cleanedPhone = phone.trim();
    if (!/^\+[1-9]\d{0,2}$/.test(cleanedPhoneCountryCode)
      || !/^\+[1-9]\d{1,14}$/.test(cleanedPhone)
      || !cleanedPhone.startsWith(cleanedPhoneCountryCode)) {
      return res.status(400).json({ message: 'The phone number must match the selected country code.' });
    }

    const roleField = designation === 'Teacher'
      ? islamicEducation
      : designation === 'Video Editor'
        ? skills
        : tiktokAccount;

    if (typeof roleField !== 'string' || !roleField.trim()) {
      return res.status(400).json({ message: `Please complete the required ${designation} details.` });
    }

    if (endTime <= startTime) {
      return res.status(400).json({ message: 'Please choose a valid availability time range.' });
    }

    const cleaned = Object.fromEntries(Object.entries({
      fullName: cleanedFullName,
      email,
      phoneCountryCode,
      phoneNumber,
      phone,
      country,
      profession,
      designation,
      ageGroup,
      gender,
      timezone,
      faith,
      instructionLanguage,
      startTime,
      endTime,
      availability,
      availabilityDetails,
      goals,
      islamicEducation,
      skills,
      tiktokAccount,
      roleDetails: roleField
    }).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : '']));

    const saved = await VolunteerEntry.create(cleaned);
    const emailText = [
      'New Volunteer Application',
      '',
      `Full Name: ${cleaned.fullName}`,
      `Email: ${cleaned.email}`,
      `WhatsApp Country Code: ${cleaned.phoneCountryCode}`,
      `WhatsApp Local Number: ${cleaned.phoneNumber}`,
      `WhatsApp Number (international): ${cleaned.phone}`,
      `Country: ${cleaned.country}`,
      `Profession: ${cleaned.profession}`,
      `Designation: ${cleaned.designation}`,
      `Age Group: ${cleaned.ageGroup}`,
      `Gender: ${cleaned.gender}`,
      `Time Zone: ${cleaned.timezone}`,
      `Faith: ${cleaned.faith}`,
      `Language of Instruction: ${cleaned.instructionLanguage}`,
      `Available From: ${cleaned.startTime}`,
      `Available To: ${cleaned.endTime}`,
      `Availability: ${cleaned.availability}${cleaned.availabilityDetails ? ` (${cleaned.availabilityDetails})` : ''}`,
      `${cleaned.designation === 'Teacher' ? 'Islamic Education / Background' : cleaned.designation === 'Video Editor' ? 'Video Editing Skills' : 'TikTok Account'}: ${cleaned.roleDetails}`,
      `Goals: ${cleaned.goals}`,
      '',
      'Volunteer application saved in MongoDB.'
    ].join('\n');

    notifyAdmin({
      subject: `New volunteer application: ${cleaned.designation}`,
      text: emailText,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h3>New Volunteer Application</h3>
          <p><strong>Full Name:</strong> ${cleaned.fullName}</p>
          <p><strong>Email:</strong> ${cleaned.email}</p>
          <p><strong>WhatsApp Country Code:</strong> ${cleaned.phoneCountryCode}</p>
          <p><strong>WhatsApp Local Number:</strong> ${cleaned.phoneNumber}</p>
          <p><strong>WhatsApp Number (international):</strong> ${cleaned.phone}</p>
          <p><strong>Country:</strong> ${cleaned.country}</p>
          <p><strong>Profession:</strong> ${cleaned.profession}</p>
          <p><strong>Designation:</strong> ${cleaned.designation}</p>
          <p><strong>Age Group:</strong> ${cleaned.ageGroup}</p>
          <p><strong>Gender:</strong> ${cleaned.gender}</p>
          <p><strong>Time Zone:</strong> ${cleaned.timezone}</p>
          <p><strong>Faith:</strong> ${cleaned.faith}</p>
          <p><strong>Language of Instruction:</strong> ${cleaned.instructionLanguage}</p>
          <p><strong>Available From:</strong> ${cleaned.startTime}</p>
          <p><strong>Available To:</strong> ${cleaned.endTime}</p>
          <p><strong>Availability:</strong> ${cleaned.availability}${cleaned.availabilityDetails ? ` (${cleaned.availabilityDetails})` : ''}</p>
          <p><strong>${cleaned.designation === 'Teacher' ? 'Islamic Education / Background' : cleaned.designation === 'Video Editor' ? 'Video Editing Skills' : 'TikTok Account'}:</strong> ${cleaned.roleDetails}</p>
          <p><strong>Goals:</strong> ${cleaned.goals}</p>
        </div>
      `
    });

    res.status(201).json({
      message: 'Volunteer application submitted successfully.',
      data: saved
    });
  } catch (error) {
    console.error('Volunteer application failed:', error);
    res.status(500).json({ message: 'Failed to submit the volunteer application.' });
  }
});

async function startServer() {
  if (!process.env.MONGO_URI) {
    console.warn('MONGO_URI is missing. Set it in a .env file before starting the backend.');
  }

  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      console.log('MongoDB connected successfully');
    } catch (error) {
      console.error('MongoDB connection failed:', error.message);
      process.exit(1);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`Mauiza backend running on port ${PORT}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. The Mauiza backend may already be running.`);
      console.error(`Check it with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
      process.exit(1);
    }

    console.error('Backend server failed to start:', error.message);
    process.exit(1);
  });
}

startServer();
