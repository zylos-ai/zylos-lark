/**
 * Lark Calendar Functions
 */

import { getClient } from './client.js';

/**
 * Get primary calendar ID
 */
export async function getPrimaryCalendar() {
  const client = getClient();

  try {
    const res = await client.calendar.calendar.primary({});

    if (res.code === 0) {
      return {
        success: true,
        calendarId: res.data.calendars?.[0]?.calendar?.calendar_id,
      };
    } else {
      return {
        success: false,
        message: `Failed to get primary calendar: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * List calendar events
 * @param {number} days - Number of days to look ahead
 * @param {string} calendarId - Calendar ID (optional, uses primary if not specified)
 */
export async function listEvents(days = 7, calendarId = null) {
  const client = getClient();

  // Get calendar ID if not provided
  if (!calendarId) {
    const primaryResult = await getPrimaryCalendar();
    if (!primaryResult.success) {
      return primaryResult;
    }
    calendarId = primaryResult.calendarId;
  }

  if (!calendarId) {
    return { success: false, message: 'No calendar ID available' };
  }

  // Calculate time range
  const now = new Date();
  const startTime = Math.floor(now.getTime() / 1000).toString();
  const endTime = Math.floor((now.getTime() + days * 24 * 60 * 60 * 1000) / 1000).toString();

  try {
    const res = await client.calendar.calendarEvent.list({
      path: {
        calendar_id: calendarId,
      },
      params: {
        start_time: startTime,
        end_time: endTime,
        page_size: 50,
      },
    });

    if (res.code === 0) {
      const events = (res.data.items || []).map(event => ({
        id: event.event_id,
        summary: event.summary,
        description: event.description,
        startTime: formatEventTime(event.start_time),
        endTime: formatEventTime(event.end_time),
        location: event.location?.name,
        status: event.status,
      }));

      // Sort by start time
      events.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      return {
        success: true,
        events,
        hasMore: res.data.has_more,
      };
    } else {
      return {
        success: false,
        message: `Failed to list events: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Format event time from Lark API format
 */
function formatEventTime(timeObj) {
  if (!timeObj) return null;

  // Lark returns timestamp in seconds
  if (timeObj.timestamp) {
    return new Date(parseInt(timeObj.timestamp) * 1000).toISOString();
  }

  // Or date string for all-day events
  if (timeObj.date) {
    return timeObj.date;
  }

  return null;
}
