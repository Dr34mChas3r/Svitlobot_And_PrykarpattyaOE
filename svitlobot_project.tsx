import React, { useState } from 'react';
import { Download, Play, Settings, Activity, Calendar, Zap } from 'lucide-react';

const SvitloBotProject = () => {
  const [activeTab, setActiveTab] = useState('sync');

  const syncPyCode = `#!/usr/bin/env python3
"""
СвітлоБот-синхронізатор v1.0
Автоматично синхронізує графік відключень з be-svitlo до svitlobot.in.ua
"""

import requests
import json
import os
import time
from datetime import datetime
from pathlib import Path
import logging

# ============ НАЛАШТУВАННЯ ============
CHANNEL_KEY = "ВАШ_КЛЮЧ_СЮДИ"  # 🔑 Замініть на ваш реальний ключ
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
    level=logging.INFO,
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

def build_day_string(schedule_data):
    """
    Побудувати 24-символьний рядок для дня
    
    Формат:
    0 = світло є
    1 = повністю без світла
    2 = вимкнено першу половину години (00-30)
    3 = вимкнено другу половину (30-00)
    """
    hours = ['0'] * 24
    
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
        
        # Обробляємо перший час
        if from_m == 0:
            start_hour = from_h
        elif from_m == 30:
            hours[from_h] = '3'  # Друга половина години
            start_hour = from_h + 1
        else:
            # Якщо хвилини не 0 і не 30, вважаємо з наступної години
            start_hour = from_h + 1
        
        # Обробляємо останній час
        if to_m == 0:
            end_hour = to_h - 1
        elif to_m == 30:
            end_hour = to_h - 1
            if end_hour >= start_hour:
                hours[to_h] = '2'  # Перша половина години
        else:
            end_hour = to_h
        
        # Заповнюємо повні години між початком і кінцем
        for h in range(start_hour, min(end_hour + 1, 24)):
            if hours[h] == '0':
                hours[h] = '1'
    
    return ''.join(hours)

def fetch_schedule(target_date=None):
    """Отримати графік з be-svitlo для заданої дати"""
    try:
        # Headers для обходу захисту від ботів
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://svitlo.oe.if.ua/',
            'Origin': 'https://svitlo.oe.if.ua',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        }
        
        response = requests.get(BE_SVITLO_API, headers=headers, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        
        # Якщо дата не вказана, беремо сьогодні
        if target_date is None:
            target_date = datetime.now()
        
        date_str = target_date.strftime('%d.%m.%Y')
        
        if isinstance(data, list):
            for day_data in data:
                # Формат API: eventDate замість date
                if day_data.get('eventDate') == date_str:
                    # Дані в queues -> {queue} -> масив подій
                    queues_data = day_data.get('queues', {})
                    if QUEUE in queues_data:
                        return queues_data[QUEUE]
                    else:
                        logger.warning(f"Черга {QUEUE} не знайдена в даних для {date_str}")
                        return []
        
        logger.warning(f"Графік на {date_str} не знайдено в API")
        return []
        
    except requests.RequestException as e:
        logger.error(f"Помилка запиту до be-svitlo: {e}")
        return None
    except Exception as e:
        logger.error(f"Помилка обробки даних: {e}")
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
    
    from datetime import timedelta
    
    day_names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
    
    # Завантажуємо дані тижня
    week_data = load_week_data()
    has_changes = False
    
    # Оновлюємо сьогодні та завтра
    for day_offset in [0, 1]:  # 0 = сьогодні, 1 = завтра
        target_date = datetime.now() + timedelta(days=day_offset)
        weekday = target_date.weekday()
        
        # Отримуємо графік для цього дня
        schedule = fetch_schedule(target_date)
        
        if schedule is None:
            logger.warning(f"⏸ Не вдалося отримати графік для {day_names[weekday]} ({target_date.strftime('%d.%m')})")
            continue
        
        # Будуємо рядок для дня
        new_day_string = build_day_string(schedule)
        
        # Перевіряємо, чи змінився графік
        if week_data['days'][weekday] != new_day_string:
            week_data['days'][weekday] = new_day_string
            has_changes = True
            
            # Підраховуємо години відключень
            outage_hours = new_day_string.count('1') + new_day_string.count('2') + new_day_string.count('3')
            day_label = "Сьогодні" if day_offset == 0 else "Завтра"
            logger.info(f"📝 {day_label} ({day_names[weekday]}): {outage_hours} год. відключень - ЗМІНЕНО")
        else:
            day_label = "сьогодні" if day_offset == 0 else "завтра"
            logger.info(f"⏸ Змін не виявлено для {day_label} ({day_names[weekday]})")
    
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
    logger.info("🚀 СвітлоБот-синхронізатор запущено")
    logger.info(f"📍 Черга: {QUEUE}")
    logger.info(f"⏱ Інтервал перевірки: {CHECK_INTERVAL} секунд")
    logger.info("=" * 60)
    
    if CHANNEL_KEY == "ВАШ_КЛЮЧ_СЮДИ":
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
        logger.info("\\n👋 Зупинка бота...")
    except Exception as e:
        logger.error(f"💥 Критична помилка: {e}")

if __name__ == "__main__":
    main()
`;

  const requirementsCode = `# СвітлоБот-синхронізатор
# Залежності проєкту

requests>=2.31.0
`;

  const readmeCode = `# 🔥 СвітлоБот-синхронізатор

Автоматичний бот для синхронізації графіків відключень електроенергії між **be-svitlo.oe.if.ua** та **svitlobot.in.ua**.

## 📋 Можливості

✅ Автоматична синхронізація кожні 5 хвилин  
✅ Оновлює **сьогодні та завтра** у графіку  
✅ Зберігає історію тижнів локально  
✅ Детальне логування всіх операцій  
✅ Обробка помилок та повторні спроби  

## 🚀 Швидкий старт

### 1. Встановлення

\`\`\`bash
# Клонуйте або створіть папку проєкту
mkdir svitlobot_sync
cd svitlobot_sync

# Встановіть залежності
pip install -r requirements.txt
\`\`\`

### 2. Налаштування

Відредагуйте файл \`sync.py\` та встановіть:

\`\`\`python
CHANNEL_KEY = "ваш_ключ_з_svitlobot"  # 🔑 Обов'язково!
QUEUE = "6.1"  # 📍 Ваша черга відключень
CHECK_INTERVAL = 300  # ⏱ Секунд між перевірками
\`\`\`

### 3. Запуск

\`\`\`bash
python3 sync.py
\`\`\`

## 📁 Структура проєкту

\`\`\`
svitlobot_sync/
├── sync.py                    # Головний скрипт
├── requirements.txt           # Залежності
├── README.md                  # Документація
├── data/                      # Дані тижнів
│   ├── timetable_week_44.json
│   └── timetable_week_45.json
└── logs/                      # Логи
    └── sync.log
\`\`\`

## 🎯 Як це працює

1. **Кожні 5 хвилин** бот запитує графік з \`be-svitlo\` для **сьогодні та завтра**
2. **Конвертує** дані у формат \`timetableData\` (7 рядків по 24 символи)
3. **Порівнює** з локально збереженим графіком обидва дні
4. **Оновлює** сьогодні та завтра на \`svitlobot.in.ua\` (якщо є зміни)
5. **Зберігає** оновлений тиждень локально

## 📊 Формат timetableData

Кожна година представлена символом:
- \`0\` — світло є
- \`1\` — повністю без світла
- \`2\` — вимкнено 00-30 хв
- \`3\` — вимкнено 30-60 хв

Приклад:
\`\`\`
000000000000000111200000  # Відключення 15:00-17:30
\`\`\`

## 📝 Логи

Приклад виводу:

\`\`\`
[31.10 18:45] INFO: 🔄 Початок синхронізації...
[31.10 18:45] INFO: ✅ Оновлено Пт: 3 год. відключень
[31.10 18:50] INFO: ⏸ Змін не виявлено (Пт)
\`\`\`

## ⚙️ Налаштування

### Зміна інтервалу перевірки

\`\`\`python
CHECK_INTERVAL = 600  # 10 хвилин
\`\`\`

### Зміна черги

\`\`\`python
QUEUE = "3.2"  # Ваша черга
\`\`\`

## 🐛 Вирішення проблем

### Помилка "CHANNEL_KEY не встановлено"
➡️ Встановіть ваш ключ у \`sync.py\`

### Помилка "Не вдалося отримати графік"
➡️ Перевірте доступність \`be-svitlo.oe.if.ua\`  
➡️ Перевірте правильність вашої черги

### Бот не оновлює графік
➡️ Перевірте логи у \`logs/sync.log\`  
➡️ Переконайтеся, що \`CHANNEL_KEY\` правильний

## 🔄 Автозапуск (Linux)

### Systemd сервіс

Створіть \`/etc/systemd/system/svitlobot.service\`:

\`\`\`ini
[Unit]
Description=СвітлоБот Синхронізатор
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/svitlobot_sync
ExecStart=/usr/bin/python3 /path/to/svitlobot_sync/sync.py
Restart=always

[Install]
WantedBy=multi-user.target
\`\`\`

Запустіть:
\`\`\`bash
sudo systemctl enable svitlobot
sudo systemctl start svitlobot
sudo systemctl status svitlobot
\`\`\`

## 📜 Ліцензія

MIT License - використовуйте вільно!

## 💬 Підтримка

Якщо виникли питання, перевірте:
- 📝 Логи у \`logs/sync.log\`
- 🌐 Доступність API
- 🔑 Правильність \`CHANNEL_KEY\`

---

**Зроблено з ❤️ для України 🇺🇦**
`;

  const files = {
    sync: { code: syncPyCode, lang: 'python', name: 'sync.py' },
    requirements: { code: requirementsCode, lang: 'text', name: 'requirements.txt' },
    readme: { code: readmeCode, lang: 'markdown', name: 'README.md' }
  };

  const downloadFile = (filename, content) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6 border-l-4 border-blue-500">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-blue-100 rounded-xl">
              <Zap className="w-8 h-8 text-blue-600" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-800">СвітлоБот-синхронізатор</h1>
              <p className="text-gray-600">Автоматична синхронізація графіків відключень</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
              <Activity className="w-5 h-5 text-green-600" />
              <div>
                <div className="text-sm text-gray-600">Оновлення</div>
                <div className="font-semibold text-gray-800">Кожні 5 хв</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 bg-purple-50 rounded-lg">
              <Calendar className="w-5 h-5 text-purple-600" />
              <div>
                <div className="text-sm text-gray-600">Режим</div>
                <div className="font-semibold text-gray-800">Сьогодні + Завтра</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 bg-orange-50 rounded-lg">
              <Settings className="w-5 h-5 text-orange-600" />
              <div>
                <div className="text-sm text-gray-600">Статус</div>
                <div className="font-semibold text-gray-800">Готово до запуску</div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="flex border-b border-gray-200">
            {Object.entries(files).map(([key, file]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 px-6 py-4 font-medium transition-colors ${
                  activeTab === key
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                {file.name}
              </button>
            ))}
          </div>

          {/* Code Display */}
          <div className="p-6">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
                  {files[activeTab].lang}
                </span>
                <span className="text-gray-500 text-sm">
                  {files[activeTab].code.split('\n').length} рядків
                </span>
              </div>
              <button
                onClick={() => downloadFile(files[activeTab].name, files[activeTab].code)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                <Download className="w-4 h-4" />
                Завантажити
              </button>
            </div>

            <pre className="bg-gray-900 text-gray-100 p-6 rounded-xl overflow-x-auto text-sm leading-relaxed">
              <code>{files[activeTab].code}</code>
            </pre>
          </div>
        </div>

        {/* Quick Start */}
        <div className="mt-6 bg-gradient-to-r from-green-500 to-emerald-500 rounded-2xl shadow-xl p-8 text-white">
          <div className="flex items-center gap-3 mb-4">
            <Play className="w-6 h-6" />
            <h2 className="text-2xl font-bold">Швидкий старт</h2>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-lg p-4 font-mono text-sm space-y-2">
            <div>$ pip install requests</div>
            <div>$ python3 sync.py</div>
          </div>
          <div className="mt-4 text-green-100">
            ⚠️ Не забудьте встановити <strong>CHANNEL_KEY</strong> та <strong>QUEUE</strong> у sync.py
          </div>
        </div>
      </div>
    </div>
  );
};

export default SvitloBotProject;