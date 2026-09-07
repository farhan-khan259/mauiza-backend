import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({ origin: true, credentials: true }));
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
  ageGroup: String,
  gender: String,
  course: String,
  startTime: String,
  endTime: String,
  schedule: String,
  goals: String,
  createdAt: { type: Date, default: Date.now }
});

const ContactMessage = mongoose.model('ContactMessage', contactSchema);
const RegistrationEntry = mongoose.model('RegistrationEntry', registrationSchema);

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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Mauiza backend is running' });
});

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ message: 'All contact fields are required.' });
    }

    const saved = await ContactMessage.create({
      name,
      email,
      subject,
      message
    });

    const emailText = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${subject}`,
      '',
      'Message:',
      message
    ].join('\n');

    const emailSent = await sendAdminMail({
      subject: `New contact message: ${subject}`,
      text: emailText,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h3>New Contact Message</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Subject:</strong> ${subject}</p>
          <p><strong>Message:</strong></p>
          <p>${message.replace(/\n/g, '<br />')}</p>
        </div>
      `
    });

    res.status(201).json({
      message: emailSent
        ? 'Your message has been sent successfully.'
        : 'Your message was saved successfully. Email notification is temporarily unavailable.',
      emailSent,
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
      ageGroup,
      gender,
      course,
      startTime,
      endTime,
      schedule,
      goals,
      name
    } = req.body;

    const cleanedFullName = fullName || name || '';

    if (!cleanedFullName || !email || !phone || !ageGroup || !gender || !course) {
      return res.status(400).json({ message: 'Please complete all required registration fields.' });
    }

    const saved = await RegistrationEntry.create({
      fullName: cleanedFullName,
      email,
      phone,
      ageGroup,
      gender,
      course,
      startTime,
      endTime,
      schedule,
      goals
    });

    const emailText = [
      `Full Name: ${cleanedFullName}`,
      `Email: ${email}`,
      `WhatsApp Number: ${phone}`,
      `Age Group: ${ageGroup}`,
      `Gender: ${gender}`,
      `Course: ${course}`,
      `Preferred Time: ${schedule || `${startTime || 'N/A'} - ${endTime || 'N/A'}`}`,
      `Learning Goals: ${goals || 'Not provided'}`,
      '',
      'Registration details saved in MongoDB.'
    ].join('\n');

    const emailSent = await sendAdminMail({
      subject: `New registration: ${course}`,
      text: emailText,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h3>New Registration</h3>
          <p><strong>Full Name:</strong> ${cleanedFullName}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>WhatsApp Number:</strong> ${phone}</p>
          <p><strong>Age Group:</strong> ${ageGroup}</p>
          <p><strong>Gender:</strong> ${gender}</p>
          <p><strong>Course:</strong> ${course}</p>
          <p><strong>Preferred Time:</strong> ${schedule || `${startTime || 'N/A'} - ${endTime || 'N/A'}`}</p>
          <p><strong>Learning Goals:</strong> ${goals || 'Not provided'}</p>
        </div>
      `
    });

    res.status(201).json({
      message: emailSent
        ? 'Registration submitted successfully.'
        : 'Registration saved successfully. Email notification is temporarily unavailable.',
      emailSent,
      data: saved
    });
  } catch (error) {
    console.error('Registration failed:', error);
    res.status(500).json({ message: 'Failed to submit the registration.' });
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
