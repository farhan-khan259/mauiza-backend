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

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mauiza-Daily-Essentials/1.0 (mauizainstitute@gmail.com)' }
    });
    if (!response.ok) throw new Error('City search failed');
    const results = await response.json();
    res.json({ data: results.map((place) => ({
      latitude: place.lat,
      longitude: place.lon,
      city: place.address?.city || place.address?.town || place.address?.village || place.display_name.split(',')[0],
      country: place.address?.country || '',
      label: place.display_name
    })) });
  } catch (error) {
    console.error('Geocoding failed:', error);
    res.status(502).json({ message: 'City search is temporarily unavailable.' });
  }
});

const halalIngredientRecords = [
  { patterns: ['e120', 'carmine', 'cochineal'], classification: 'Potentially Haram', reason: 'Carmine/cochineal is a red colourant derived from insects. Seek a recognised halal certification if it is present.', source: 'Halal ingredient reference: insect-derived colourants' },
  { patterns: ['e441', 'gelatin', 'gelatine'], classification: 'Requires Verification / Mushbooh', reason: 'Gelatin may come from fish, bovine, porcine, or other sources. The source and halal certification must be verified.', source: 'Halal ingredient reference: animal-derived gelatin' },
  { patterns: ['e471', 'e472', 'mono- and diglycerides', 'mono and diglycerides'], classification: 'Requires Verification / Mushbooh', reason: 'Mono- and diglycerides can be produced from plant or animal fats. The source is not identifiable from the label alone.', source: 'Halal ingredient reference: emulsifiers' },
  { patterns: ['e422', 'glycerol', 'glycerin', 'glycerine'], classification: 'Requires Verification / Mushbooh', reason: 'Glycerol can be plant-, synthetic-, or animal-derived. Ask the manufacturer about its source.', source: 'Halal ingredient reference: glycerol' },
  { patterns: ['e904', 'shellac'], classification: 'Requires Verification / Mushbooh', reason: 'Shellac is a resin secreted by insects. Consult a trusted halal authority for the product context.', source: 'Halal ingredient reference: shellac' },
  { patterns: ['e1105', 'lysozyme'], classification: 'Requires Verification / Mushbooh', reason: 'Lysozyme is commonly obtained from egg white, but source and processing should be verified.', source: 'Halal ingredient reference: enzymes' },
  { patterns: ['e100', 'curcumin', 'e160a', 'beta-carotene', 'e300', 'ascorbic acid', 'e330', 'citric acid', 'e500', 'sodium bicarbonate', 'sugar', 'salt', 'flour'], classification: 'Generally Halal', reason: 'This ingredient is generally considered halal when no prohibited processing aids or additives are involved.', source: 'Halal ingredient reference: generally plant/mineral-derived ingredients' }
];

function ingredientTokens(value) {
  return [...new Set(String(value || '').toLowerCase().match(/e\s*-?\s*\d{3,4}|[a-z][a-z -]{2,}/g)?.map((item) => item.replace(/\s+/g, ' ').trim()) || [])];
}

function splitIngredientEntries(value) {
  return [...new Set(String(value || '').split(/[\n,;]+/).map((item) => item.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

app.post('/api/halal/analyze', (req, res) => {
  const rawIngredients = String(req.body?.ingredients || '').trim();
  if (!rawIngredients) return res.status(400).json({ message: 'Ingredient text is required.' });

  const ingredientEntries = splitIngredientEntries(rawIngredients);

  const results = ingredientEntries.map((entry) => {
    const normalized = entry.toLowerCase().replace(/e\s*-?\s*(\d{3,4})/g, 'e$1');
    const matchingRecord = halalIngredientRecords.find((record) => record.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())));

    if (matchingRecord) {
      const pattern = matchingRecord.patterns.find((item) => normalized.includes(item.toLowerCase()));
      return {
        name: pattern && /^e\d+$/.test(pattern) ? `Additive ${pattern.toUpperCase()}` : (pattern || entry).replace(/\b\w/g, (letter) => letter.toUpperCase()),
        eNumber: /^e\d+$/.test(pattern || '') ? pattern.toUpperCase() : undefined,
        classification: matchingRecord.classification,
        reason: matchingRecord.reason,
        source: matchingRecord.source
      };
    }

    const lowerEntry = entry.toLowerCase();
    const strongHaram = ['bear', 'pork', 'bacon', 'ham', 'lard', 'suet', 'cochineal', 'carmine', 'blood'];
    const strongHalal = ['sugar', 'salt', 'flour', 'water', 'olive oil', 'palm oil', 'rice', 'corn starch', 'cornstarch', 'citric acid', 'ascorbic acid', 'sodium bicarbonate', 'beta-carotene', 'curcumin'];

    if (strongHaram.some((term) => lowerEntry.includes(term))) {
      return {
        name: entry.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        classification: 'Potentially Haram',
        reason: 'This ingredient is commonly associated with animal-based or restricted sources and should be checked before use.',
        source: 'Mauiza ingredient reference — restricted ingredient list'
      };
    }

    if (strongHalal.some((term) => lowerEntry.includes(term))) {
      return {
        name: entry.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        classification: 'Generally Halal',
        reason: 'This ingredient is usually accepted as halal when no prohibited processing aids or cross-contamination are involved.',
        source: 'Mauiza ingredient reference — common halal ingredient list'
      };
    }

    const token = ingredientTokens(entry).find((item) => /^e\s*-?\s*\d{3,4}$/.test(item));
    if (token) {
      const eNumber = token.replace(/\s|-/g, '').toUpperCase();
      return {
        name: `Additive ${eNumber}`,
        eNumber,
        classification: 'Requires Verification / Mushbooh',
        reason: 'This E-number was detected, but no verified record is available in the configured reference set. Check the manufacturer and recognised halal certification.',
        source: 'Mauiza ingredient reference — record unavailable'
      };
    }

    return {
      name: entry.replace(/\b\w/g, (letter) => letter.toUpperCase()),
      classification: 'Requires Verification / Mushbooh',
      reason: 'This ingredient did not match the current halal reference list. Please confirm the source and packaging information before relying on it.',
      source: 'Mauiza ingredient reference — no match found'
    };
  });

  res.json({ results });
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

app.get('/api/nearby-places', async (req, res) => {
  const latitude = Number(req.query.latitude), longitude = Number(req.query.longitude), radius = Math.min(Math.max(Number(req.query.radius) || 5, 1), 25);
  const category = String(req.query.category || 'All');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ message: 'A valid search location is required.' });
  const mosqueQuery = 'node["amenity"="place_of_worship"]["religion"="muslim"](around:R,LAT,LON);way["amenity"="place_of_worship"]["religion"="muslim"](around:R,LAT,LON);';
  const foodQuery = 'node["diet:halal"="yes"](around:R,LAT,LON);way["diet:halal"="yes"](around:R,LAT,LON);';
  const query = category === 'Mosques' || category === 'Islamic Centers' ? mosqueQuery : category === 'Halal Food' ? foodQuery : `${mosqueQuery}${foodQuery}`;
  const overpass = `[out:json][timeout:20];(${query.replaceAll('R', String(radius * 1000)).replaceAll('LAT', latitude).replaceAll('LON', longitude)});out center tags;`;
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mauiza-Daily-Essentials/1.0' }, body: overpass });
    if (!response.ok) throw new Error('Nearby places request failed');
    const payload = await response.json();
    const results = (payload.elements || []).map((place) => { const placeLatitude = place.lat ?? place.center?.lat, placeLongitude = place.lon ?? place.center?.lon, tags = place.tags || {}; return { id: `${place.type}-${place.id}`, name: tags.name || 'Unnamed place', address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || 'Address unavailable', category: tags.amenity === 'place_of_worship' ? 'Mosque / Islamic center' : 'Halal food', latitude: placeLatitude, longitude: placeLongitude, distanceKm: Number(distanceInKm(latitude, longitude, placeLatitude, placeLongitude).toFixed(1)), directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${placeLatitude},${placeLongitude}` }; }).sort((a, b) => a.distanceKm - b.distanceKm);
    res.json({ results });
  } catch (error) { console.error('Nearby places failed:', error); res.status(502).json({ message: 'Nearby places are temporarily unavailable. Please try again.' }); }
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

    if ([cleanedFullName, email, phone, country, ageGroup, gender, timezone, instructionLanguage, faith, course, startTime, endTime, goals]
      .some((value) => typeof value !== 'string' || !value.trim())) {
      return res.status(400).json({ message: 'Please complete all required registration fields.' });
    }

    const cleanedEmail = email.trim();
    const cleanedPhone = phone.trim();
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
      `WhatsApp Number: ${phone}`,
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
          <p><strong>WhatsApp Number:</strong> ${phone}</p>
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
    const commonFields = [cleanedFullName, email, phone, country, profession, designation, ageGroup, gender, timezone, faith, instructionLanguage, startTime, endTime, availability, goals];

    if (commonFields.some((value) => typeof value !== 'string' || !value.trim()) || !allowedDesignations.includes(designation)) {
      return res.status(400).json({ message: 'Please complete all required volunteer fields.' });
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
      `WhatsApp Number: ${cleaned.phone}`,
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
          <p><strong>WhatsApp Number:</strong> ${cleaned.phone}</p>
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
