#!/usr/bin/env python3
"""
СвітлоБот-синхронізатор v2.0
Автоматично синхронізує графік відключень з be-svitlo до svitlobot.in.ua
"""

import requests
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
import logging

# ============ НАЛАШТУВАННЯ ============
CHANNEL_KEY = "***HIDDEN***"  # 🔑 Замініть на ваш реальний ключ
QUEUE = "6.1"  # 📍 Змініть на вашу чергу (наприклад, "3.2")
CHECK_INTERVAL = 300  # ⏱ Секунд між перевірками (300 = 5 хв)

# API endpoints
BE_SVITLO_API = f"https://be-svitlo.oe.if.ua/schedule-by-queue?queue={QUEUE}"
SVITLOBOT_API = "https://api.svitlobot.in.ua/website/timetableEditEvent"

# ============ ІНІЦІАЛІЗАЦІЯ ============
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"

# Створюємо директорії
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

# Налаштування логування
logging.basicConfig(
    level=logging.DEBUG,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%d.%m %H:%M',
    handlers=[
        logging.FileHandler(LOGS_DIR / "sync.log", encoding='utf-8'),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)

# ============ ДОПОМІЖНІ ФУНКЦІЇ ============


def get_week_file():
    """Отримати шлях до файлу поточного тижня"""
    week_num = datetime.now().isocalendar()[1]
    return DATA_DIR / f"timetable_week_{week_num}.json"


def load_week_data():
    """Завантажити дані поточного тижня"""
    week_file = get_week_file()

    if week_file.exists():
        try:
            with open(week_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Помилка читання {week_file.name}: {e}")

    # Повертаємо порожній тиждень (всі дні без відключень)
    return {
        "week": datetime.now().isocalendar()[1],
        "days": ["0" * 24 for _ in range(7)]
    }


def save_week_data(data):
    """Зберегти дані тижня"""
    week_file = get_week_file()
    try:
        with open(week_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f"Помилка запису {week_file.name}: {e}")
        return False


def parse_time(time_str):
    """Перетворити час '15:00' у години та хвилини"""
    try:
        h, m = map(int, time_str.split(':'))
        return h, m
    except:
        return None, None


def build_day_string(schedule_data, target_date=None):
    """
    Побудувати 24-символьний рядок для дня з урахуванням поточного часу

    Формат:
    0 = світло є
    1 = повністю без світла
    2 = вимкнено першу половину години (00-30)
    3 = вимкнено другу половину (30-00)
    
    Параметри:
    - schedule_data: дані графіка з API
    - target_date: дата, для якої будується графік (за замовчуванням - сьогодні)
    """
    hours = ['0'] * 24
    
    if target_date is None:
        target_date = datetime.now()
    
    # Визначаємо, чи це сьогодні
    is_today = target_date.date() == datetime.now().date()
    current_hour = datetime.now().hour if is_today else -1

    if not schedule_data:
        return ''.join(hours)

    for event in schedule_data:
        from_time = event.get('from', '')
        to_time = event.get('to', '')

        if not from_time or not to_time:
            continue

        from_h, from_m = parse_time(from_time)
        to_h, to_m = parse_time(to_time)

        if from_h is None or to_h is None:
            continue

        # Обробляємо початок відключення
        if from_m == 0:
            start_hour = from_h
        elif from_m == 30:
            if from_h < 24:
                hours[from_h] = '3'  # Друга половина години
            start_hour = from_h + 1
        else:
            # Округлюємо до найближчої половини години
            if from_m < 30:
                hours[from_h] = '2'  # Перша половина
                start_hour = from_h + 1
            else:
                hours[from_h] = '3'  # Друга половина
                start_hour = from_h + 1

        # Обробляємо кінець відключення
        # ВАЖЛИВО: 00:00 означає кінець дня (24-та година)
        if to_h == 0 and to_m == 0:
            # Відключення до кінця дня (23:59)
            end_hour = 23
        elif to_m == 0:
            # Відключення до початку години (наприклад, до 06:00 = до 05:59)
            end_hour = to_h - 1
        elif to_m == 30:
            # Відключення до половини години
            if to_h > 0:
                hours[to_h] = '2'  # Перша половина години
            end_hour = to_h - 1
        else:
            # Округлюємо до найближчої половини години
            if to_m <= 30:
                hours[to_h] = '2'  # Перша половина
                end_hour = to_h - 1
            else:
                hours[to_h] = '3'  # Друга половина
                end_hour = to_h

        # Заповнюємо повні години між початком і кінцем
        for h in range(start_hour, min(end_hour + 1, 24)):
            if h < 24 and hours[h] == '0':
                hours[h] = '1'

    return ''.join(hours)

def merge_day_strings(old_string, new_string, target_date):
    """
    Об'єднати старий і новий графіки, зберігаючи минулі години без змін
    
    Параметри:
    - old_string: поточний збережений графік
    - new_string: новий графік з API
    - target_date: дата, для якої оновлюється графік
    
    Повертає: оновлений рядок графіка
    """
    is_today = target_date.date() == datetime.now().date()
    
    # Якщо це не сьогодні, просто повертаємо новий графік
    if not is_today:
        return new_string
    
    current_hour = datetime.now().hour
    result = list(old_string)
    
    # Оновлюємо тільки поточну та майбутні години
    for h in range(current_hour, 24):
        result[h] = new_string[h]
    
    return ''.join(result)


def fetch_schedule(target_date=None):
    """Отримати графік з be-svitlo для заданої дати"""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'uk-UA,uk;q=0.9',
            'Referer': 'https://svitlo.oe.if.ua/',
            'Origin': 'https://svitlo.oe.if.ua'
        }

        response = requests.get(BE_SVITLO_API, headers=headers, timeout=10)
        response.raise_for_status()

        logger.debug(f"Response status: {response.status_code}")

        if not response.text.strip():
            logger.error("Сервер повернув порожню відповідь")
            return None

        try:
            data = response.json()
        except ValueError as e:
            logger.error(f"Відповідь не є валідним JSON: {e}")
            return None

        # Якщо дата не вказана, беремо сьогодні
        if target_date is None:
            target_date = datetime.now()

        date_str = target_date.strftime('%d.%m.%Y')

        # API повертає список днів
        if isinstance(data, list):
            for day_data in data:
                if day_data.get('eventDate') == date_str:
                    queues_data = day_data.get('queues', {})
                    if QUEUE in queues_data:
                        events = queues_data[QUEUE]
                        logger.debug(f"Знайдено {len(events)} подій для {date_str}, черга {QUEUE}")
                        return events
                    else:
                        logger.warning(f"Черга {QUEUE} не знайдена для {date_str}")
                        return []

        logger.warning(f"Графік на {date_str} не знайдено в API")
        return []

    except requests.RequestException as e:
        logger.error(f"Помилка HTTP запиту: {e}")
        return None
    except Exception as e:
        logger.error(f"Несподівана помилка: {e}")
        return None


def send_to_svitlobot(timetable_data):
    """Відправити оновлений графік на svitlobot"""
    try:
        url = f"{SVITLOBOT_API}?channel_key={CHANNEL_KEY}&timetableData={timetable_data}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()

        logger.info("✅ Графік успішно оновлено на svitlobot.in.ua")
        return True

    except requests.RequestException as e:
        logger.error(f"❌ Помилка відправки на svitlobot: {e}")
        return False


def sync_schedule():
    """Основна функція синхронізації"""
    logger.info("🔄 Початок синхронізації...")

    day_names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']

    # Завантажуємо дані тижня
    week_data = load_week_data()
    has_changes = False

    # Поточний день тижня (0=Пн, 6=Нд)
    current_weekday = datetime.now().weekday()
    current_hour = datetime.now().hour

    # ВАЖЛИВО: Минулі дні НЕ очищаємо - зберігаємо їх до кінця тижня
    # API їх стирає, але ми маємо локальну копію
    logger.debug(f"Минулі дні тижня (0-{current_weekday-1}) зберігаються з локального кешу")

    # Оновлюємо сьогодні і наступні 6 днів (весь тиждень від сьогодні)
    for day_offset in range(7):
        target_date = datetime.now() + timedelta(days=day_offset)
        weekday = target_date.weekday()

        # Отримуємо графік для цього дня
        schedule = fetch_schedule(target_date)

        if schedule is None:
            logger.warning(f"⏸ Не вдалося отримати графік для {day_names[weekday]} ({target_date.strftime('%d.%m')})")
            continue

        # Будуємо новий рядок для дня
        new_day_string = build_day_string(schedule, target_date)
        
        # Об'єднуємо з існуючим графіком (зберігаємо минулі години для сьогодні)
        old_day_string = week_data['days'][weekday]
        merged_day_string = merge_day_strings(old_day_string, new_day_string, target_date)

        # Перевіряємо, чи змінився графік
        if old_day_string != merged_day_string:
            week_data['days'][weekday] = merged_day_string
            has_changes = True

            # Підраховуємо години відключень
            outage_hours = merged_day_string.count('1') + merged_day_string.count('2') + merged_day_string.count('3')
            
            if day_offset == 0:
                day_label = "Сьогодні"
            elif day_offset == 1:
                day_label = "Завтра"
            else:
                day_label = target_date.strftime('%d.%m')
            
            logger.info(f"📝 {day_label} ({day_names[weekday]}): {outage_hours} год. відключень - ЗМІНЕНО")
        else:
            if day_offset == 0:
                day_label = "сьогодні"
            elif day_offset == 1:
                day_label = "завтра"
            else:
                day_label = target_date.strftime('%d.%m')
            
            logger.debug(f"⏸ Змін не виявлено для {day_label} ({day_names[weekday]})")

    # Якщо є зміни - відправляємо
    if not has_changes:
        logger.info("⏸ Жодних змін у графіках")
        return

    # Оновлюємо номер тижня
    week_data['week'] = datetime.now().isocalendar()[1]

    # Зберігаємо локально
    if not save_week_data(week_data):
        logger.error("❌ Не вдалося зберегти дані локально")
        return

    # Формуємо timetableData
    timetable_data = '%3B'.join(week_data['days'])

    # Відправляємо на svitlobot
    if send_to_svitlobot(timetable_data):
        logger.info("✅ Графік успішно синхронізовано з svitlobot.in.ua")
    else:
        logger.error("❌ Не вдалося оновити графік на svitlobot")


# ============ ГОЛОВНИЙ ЦИКЛ ============


def main():
    """Головна функція"""
    logger.info("=" * 60)
    logger.info("🚀 СвітлоБот-синхронізатор v2.0 запущено")
    logger.info(f"📍 Черга: {QUEUE}")
    logger.info(f"⏱ Інтервал перевірки: {CHECK_INTERVAL} секунд")
    logger.info("=" * 60)

    if CHANNEL_KEY == "***HIDDEN***":
        logger.error("❌ УВАГА: Не встановлено CHANNEL_KEY!")
        logger.error("Відредагуйте файл sync.py та встановіть ваш ключ")
        return

    # Перша синхронізація одразу
    sync_schedule()

    # Циклічна перевірка
    try:
        while True:
            time.sleep(CHECK_INTERVAL)
            sync_schedule()

    except KeyboardInterrupt:
        logger.info("\n👋 Зупинка бота...")
    except Exception as e:
        logger.error(f"💥 Критична помилка: {e}")


if __name__ == "__main__":
    main()
