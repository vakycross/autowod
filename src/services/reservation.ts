import { appendFileSync } from 'fs';
import { Page, ElementHandle } from 'puppeteer';
import {
  ButtonText,
  ReservationPreferences,
  ReservationResult,
  WeekDay,
} from '../types';
import { availableDays } from '../config';

export function parsePreferenceValue(value: string | null): {
  time: string | null;
  className: string | null;
} {
  if (!value) return { time: null, className: null };
  const [time, className] = value.split('|');
  return { time: time.trim() || null, className: className?.trim() || null };
}

export async function goToReservations(page: Page): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayInSeconds = Math.floor(today.getTime() / 1000);

  const currentUrl = page.url();
  const currentDomain = new URL(currentUrl).origin;

  await page.goto(`${currentDomain}/athlete/reservas.aspx?t=${todayInSeconds}`);
}

export async function getReservationState(
  reservationButton: ElementHandle<Element>
): Promise<ButtonText | null> {
  const rawText = await reservationButton.evaluate(el => el.textContent);
  if (!rawText) return null;

  // Limpiamos espacios y pasamos a minúsculas de forma totalmente segura
  const cleanText = rawText
    .replace(/[^\w\sáéíóúüñ]/gi, '')
    .trim()
    .toLowerCase();

  console.log(`🔘 Texto bruto del botón: "${rawText.trim()}" | Texto limpio: "${cleanText}"`);

  if (cleanText.includes('reservar') || cleanText.includes('entrenar')) {
    return 'Entrenar' as ButtonText;
  }
  if (cleanText.includes('avisar') || cleanText.includes('lista')) {
    return 'Avisar' as ButtonText;
  }
  if (cleanText.includes('borrar') || cleanText.includes('cancelar')) {
    return 'Borrar' as ButtonText;
  }
  if (cleanText.includes('cambiar')) {
    return 'Cambiar' as ButtonText;
  }
  if (cleanText.includes('finalizada')) {
    return 'Finalizada' as ButtonText;
  }

  return rawText.trim() as ButtonText;
}
export function getReservationKey(time: string): string {
  return `h${time.replace(':', '')}00`;
}

export async function goToNextDay(page: Page): Promise<void> {
  const url = page.url();
  const urlObj = new URL(url);
  const tParam = urlObj.searchParams.get('t');

  if (tParam) {
    const currentSeconds = Number(tParam);
    const nextDaySeconds = currentSeconds + 86400;
    urlObj.searchParams.set('t', nextDaySeconds.toString());
    
    await page.goto(urlObj.toString());
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  } else {
    await page.waitForSelector('a.next');
    await page.click('a.next');
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  }
}

export async function getWeekDayFromUrl(page: Page): Promise<string> {
  const url = await page.url();
  const weekDayInSeconds = url.split('=')[1];
  const weekDay = new Date(Number(weekDayInSeconds) * 1000);
  return weekDay
    .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
    .toLocaleLowerCase();
}

export async function getDateFromUrl(page: Page): Promise<string> {
  const url = await page.url();
  const weekDayInSeconds = url.split('=')[1];
  return Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Number(weekDayInSeconds) * 1000));
}

export function getISODateFromUrl(page: Page): string {
  const seconds = page.url().split('=')[1];
  return new Date(Number(seconds) * 1000).toISOString().split('T')[0];
}

async function findReservationButton(
  page: Page,
  reservationKey: string,
  className: string | null
): Promise<ElementHandle<Element> | null> {
  const anchorId = reservationKey.startsWith('h') ? reservationKey : `h${reservationKey}`;
  console.log(`🔎 Buscando ancla exacta en el DOM: #${anchorId}`);

  await page.waitForSelector('.horaAnchor, div.clase', { timeout: 5000 }).catch(() => {});

  const buttonHandle = await page.evaluateHandle((targetAnchorId, targetClassName) => {
    const anchor = document.getElementById(targetAnchorId);
    if (!anchor) return null;

    let nextEl = anchor.nextElementSibling;
    while (nextEl) {
      if (nextEl.classList.contains('horaAnchor')) {
        break;
      }

      if (nextEl.classList.contains('clase')) {
        const head = nextEl.querySelector('.entrenamientoHead');
        const headerText = head?.textContent?.toLowerCase() ?? '';
        
        // BuscamosCualquier botón de acción principal (entrenar, cambiar, borrar, etc.)
        const btn = nextEl.querySelector('button.button.entrenar, button.button.cambiar, button.button.borrar, button.button.avisar') as HTMLButtonElement;

        if (btn) {
          if (!targetClassName) return btn;
          if (headerText.includes(targetClassName.toLowerCase())) {
            return btn;
          }
        }
      }
      nextEl = nextEl.nextElementSibling;
    }

    return null;
  }, anchorId, className);

  const element = buttonHandle.asElement();
  return element ? (element as ElementHandle<Element>) : null;
}

export async function makeReservation(
  page: Page,
  preference: string | null
): Promise<ReservationResult> {
  const { time, className } = parsePreferenceValue(preference);
  const weekDay = await getWeekDayFromUrl(page);
  const date = getISODateFromUrl(page);
  const pageTitle = await page.$('.mainTitle');
  const pageTitleText = (await pageTitle?.evaluate(el => el.textContent)) ?? '';

  if (!time) {
    return {
      success: false,
      message: `📅 No time scheduled for ${weekDay}s`,
      weekDay,
      date,
    };
  }

  const reservationKey = getReservationKey(time);
  console.log(`🔍 Buscando clases para ${weekDay} (${date}) en la URL: ${page.url()}`);

  // Configuración del bucle de espera (intentaremos durante ~90 segundos si no aparece de inmediato)
  const maxRetries = 18; // 18 intentos * 5 segundos = 90 segundos de margen
  const retryInterval = 5000; // 5 segundos entre cada comprobación/recarga
  
  let reservationButton: ElementHandle<Element> | null = null;
  let state: ButtonText | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    reservationButton = await findReservationButton(page, reservationKey, className);

    if (reservationButton) {
      state = await getReservationState(reservationButton);
      // Si ya encontramos el botón y su estado es accionable, salimos del bucle de espera
      if (state && (state === 'Entrenar' || state === 'Avisar' || state === 'Borrar' || state === 'Cambiar')) {
        break;
      }
    }

    // Si es el último intento y no hay suerte, salimos
    if (attempt === maxRetries) break;

    console.log(`⏳ Intento ${attempt}/${maxRetries}: Slot no disponible todavía o esperando apertura. Reintentando en 5s...`);
    
    // Esperamos 5 segundos y recargamos la página para capturar la apertura en tiempo real
    await new Promise(resolve => setTimeout(resolve, retryInterval));
    await page.reload({ waitUntil: 'networkidle2' });
  }

  if (!reservationButton) {
    return {
      success: false,
      message: `🔍 No reservation slot found for ${await getDateFromUrl(page)} at ${time} after retries`,
      weekDay,
      time,
    };
  }

  if (!state) {
    return {
      success: false,
      message: `⚠️ Unable to determine reservation status for ${await getDateFromUrl(page)} at ${time}`,
      weekDay,
      time,
    };
  }

  const result: ReservationResult = {
    success: true,
    message: '',
    weekDay,
    date,
    time,
    state,
  };

  switch (state) {
    case 'Entrenar':
      await reservationButton.click();
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      result.message = `✅ ${pageTitleText} - Successfully booked! 💪`;
      break;
    case 'Avisar':
      await reservationButton.click();
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      result.message = `⏳ ${pageTitleText} - Added to waiting list. Fingers crossed! 🤞`;
      break;
    case 'Cambiar':
      result.message = `⚠️ ${pageTitleText} - You're already booked for a different time slot`;
      result.success = false;
      break;
    case 'Finalizada':
      result.message = `❌ ${pageTitleText} - This class has already finished`;
      result.success = false;
      break;
    case 'Borrar':
      result.message = `ℹ️ ${pageTitleText} - You're already booked`;
      result.success = false;
      break;
  }

  return result;
}

function writeJobSummary(
  dayResults: Array<{ weekDay: string; result: ReservationResult }>,
  counts: {
    booked: number;
    waitlisted: number;
    alreadyBooked: number;
    skipped: number;
    other: number;
  }
) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  const statusLabel = (result: ReservationResult): string => {
    if (!result.time) return '⏭️ Skipped';
    if (result.state === 'Entrenar' && result.success) return '✅ Booked';
    if (result.state === 'Avisar' && result.success) return '⏳ Waitlisted';
    if (result.state === 'Borrar') return 'ℹ️ Already booked';
    if (result.state === 'Finalizada') return '❌ Class already finished';
    if (result.state === 'Cambiar') return '⚠️ Booked at a different time';
    return '🔍 Slot not found';
  };

  const rows = dayResults.map(({ weekDay, result }) => {
    const day = weekDay.charAt(0).toUpperCase() + weekDay.slice(1);
    const time = result.time ?? '—';
    return `| ${day} | ${time} | ${statusLabel(result)} |`;
  });

  const totals = [
    counts.booked > 0 ? `**${counts.booked} booked**` : null,
    counts.waitlisted > 0 ? `${counts.waitlisted} waitlisted` : null,
    counts.alreadyBooked > 0 ? `${counts.alreadyBooked} already booked` : null,
    counts.skipped > 0 ? `${counts.skipped} skipped` : null,
    counts.other > 0 ? `${counts.other} other` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [
    '## 🏋️ AutoWOD Booking Results',
    '',
    '| Day | Time | Status |',
    '|-----|------|--------|',
    ...rows,
    '',
    totals,
    '',
  ];

  appendFileSync(summaryFile, lines.join('\n'));
}

export async function processReservations(
  page: Page,
  preferences: ReservationPreferences
): Promise<Array<{ weekDay: string; result: ReservationResult }>> {
  const dayResults: Array<{ weekDay: string; result: ReservationResult }> = [];
  let booked = 0;
  let waitlisted = 0;
  let alreadyBooked = 0;
  let other = 0;
  let skipped = 0;

  for (let i = 0; i < availableDays; i++) {
    const weekDay = await getWeekDayFromUrl(page);
    const preference = preferences[weekDay as WeekDay];

    const result = await makeReservation(page, preference);
    dayResults.push({ weekDay, result });
    console.log(result.message);

    if (!preference) {
      skipped++;
    } else if (result.state === 'Entrenar' && result.success) {
      booked++;
    } else if (result.state === 'Avisar' && result.success) {
      waitlisted++;
    } else if (result.state === 'Borrar') {
      alreadyBooked++;
    } else {
      other++;
    }

    if (i === availableDays - 1) break;

    const dateBefore = getISODateFromUrl(page);
    await goToNextDay(page);
    if (getISODateFromUrl(page) === dateBefore) {
      console.log(
        `📆 ${dateBefore} is the last bookable day for now — stopping.`
      );
      break;
    }
  }

  console.log(
    `📊 Summary -> booked: ${booked}, waitlist: ${waitlisted}, already booked: ${alreadyBooked}, skipped (no time): ${skipped}, other: ${other}`
  );

  writeJobSummary(dayResults, { booked, waitlisted, alreadyBooked, skipped, other });
  return dayResults;
}
