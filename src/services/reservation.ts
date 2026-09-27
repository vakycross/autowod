import { Page, ElementHandle } from 'puppeteer';

interface DayResult {
  date: string;
  result: {
    date: string;
    status: 'booked' | 'waitlist' | 'already_booked' | 'skipped' | 'error';
    message?: string;
  };
}

// Función auxiliar requerida por los tests
export function getReservationKey(time: string): string {
  return `h${time.replace(':', '')}00`;
}

// Función auxiliar requerida por los tests
export function parsePreferenceValue(val: unknown): boolean {
  return Boolean(val);
}

export async function goToReservations(page: Page): Promise<void> {
  await page.goto('https://imperiumbox.wodbuster.com/athlete/reservas.aspx', {
    waitUntil: 'networkidle2',
  });
}

async function findReservationButton(
  page: Page,
  reservationKey: string,
  className: string | null
): Promise<ElementHandle<Element> | null> {
  const anchorId = reservationKey.startsWith('h') ? reservationKey : `h${reservationKey}`;

  // Damos un respiro para que WodBuster renderice la parrilla
  await page.waitForSelector('.horaAnchor, div.clase', { timeout: 5000 }).catch(() => {});

  const buttonHandle = await page.evaluateHandle((targetAnchorId, targetClassName) => {
    const anchor = document.getElementById(targetAnchorId);
    if (!anchor) return null;

    // Recorremos los elementos hermanos siguientes al ancla de la hora
    let nextEl = anchor.nextElementSibling;
    while (nextEl) {
      if (nextEl.classList.contains('horaAnchor')) {
        break;
      }

      if (nextEl.classList.contains('clase')) {
        const head = nextEl.querySelector('.entrenamientoHead');
        const headerText = head?.textContent?.toLowerCase() ?? '';
        const btn = nextEl.querySelector('button.button.entrenar') as HTMLButtonElement;

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

export async function processReservations(
  page: Page,
  preferences: Record<string, any>
): Promise<DayResult[]> {
  const results: DayResult[] = [];
  const reservationKey = 'h160000'; // Bloque de las 16:00
  const className = 'WOD';

  const now = Math.floor(Date.now() / 1000);
  const daysMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  for (let i = 0; i < 7; i++) {
    const targetDate = new Date(Date.now() + i * 86400 * 1000);
    const dayName = daysMap[targetDate.getDay()];

    if (!preferences[dayName] || parsePreferenceValue(preferences[dayName]) === false) {
      continue;
    }

    const timestamp = now + i * 86400;
    const url = `https://imperiumbox.wodbuster.com/athlete/reservas.aspx?t=${timestamp}`;

    console.log(`🔎 Buscando clases para ${dayName} (${targetDate.toISOString().split('T')[0]}) en la URL: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });

    const button = await findReservationButton(page, reservationKey, className);

    if (button) {
      console.log(`🎯 ¡Botón encontrado para las 16:00 en ${dayName}! Procediendo a reservar...`);
      
      // ¡Hacemos clic real en el botón de entrenar!
      await button.click();
      await new Promise(resolve => setTimeout(resolve, 3000));

      results.push({
        date: targetDate.toISOString().split('T')[0],
        result: {
          date: targetDate.toISOString().split('T')[0],
          status: 'booked',
        },
      });
    } else {
      console.log(`❌ No reservation slot found for ${targetDate.toISOString().split('T')[0]} at 16:00`);
      results.push({
        date: targetDate.toISOString().split('T')[0],
        result: {
          date: targetDate.toISOString().split('T')[0],
          status: 'skipped',
          message: 'No reservation slot found',
        },
      });
    }
  }

  return results;
}
