import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { localDateKey } from "../../lib/dates";

export function CheckinCalendar({ activityByDate }: { activityByDate: ReadonlyMap<string, number> }) {
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const todayKey = localDateKey(new Date());
  const calendarYear = calendarMonth.getFullYear();
  const calendarMonthIndex = calendarMonth.getMonth();
  const calendarOffset = (new Date(calendarYear, calendarMonthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
  const calendarDays = Array.from({ length: calendarOffset + daysInMonth }, (_, index) =>
    index < calendarOffset ? null : new Date(calendarYear, calendarMonthIndex, index - calendarOffset + 1),
  );
  while (calendarDays.length % 7 !== 0) calendarDays.push(null);
  const checkedDays = calendarDays.filter((date) => date && activityByDate.has(localDateKey(date))).length;

  return (
    <section className="panel calendar-panel">
      <div className="calendar-heading">
        <div className="panel-heading"><CalendarDays size={20} /><h2>默写打卡日历</h2></div>
        <div className="calendar-nav">
          <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex - 1, 1))} aria-label="上一个月"><ChevronLeft size={18} /></button>
          <strong>{calendarYear} 年 {calendarMonthIndex + 1} 月</strong>
          <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex + 1, 1))} aria-label="下一个月"><ChevronRight size={18} /></button>
        </div>
      </div>
      <div className="calendar-summary">本月已打卡 <strong>{checkedDays}</strong> 天</div>
      <div className="calendar-grid calendar-weekdays" aria-hidden="true">
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>周{day}</span>)}
      </div>
      <div className="calendar-grid">
        {calendarDays.map((date, index) => {
          if (!date) return <span className="calendar-day blank" key={`blank-${index}`} />;
          const key = localDateKey(date);
          const practiceCount = activityByDate.get(key) ?? 0;
          const isToday = key === todayKey;
          return (
            <div className={`calendar-day ${practiceCount > 0 ? "checked" : ""} ${isToday ? "today" : ""}`} key={key} aria-current={isToday ? "date" : undefined}>
              <b>{date.getDate()}</b>
              {practiceCount > 0 ? <small>{practiceCount} 题次</small> : isToday ? <small>今天</small> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
