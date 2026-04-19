import { describe, test, expect, beforeEach, beforeAll, afterAll, jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockGetSession = jest.fn();
const mockUpdateSession = jest.fn();
const mockResetSession = jest.fn();
const mockGetServices = jest.fn();
const mockGetStaff = jest.fn();
const mockGetAvailableSlots = jest.fn();
const mockBookAppointment = jest.fn();
const mockGetUpcomingAppointments = jest.fn();
const mockCancelAppointment = jest.fn();
const mockRescheduleAppointment = jest.fn();
const mockGetCustomerName = jest.fn();
const mockUpsertCustomer = jest.fn();
const mockGetBusiness = jest.fn();
const mockGetBusinessByPhone = jest.fn();
const mockGetBusinessByWhatsAppPhoneNumberId = jest.fn();
const mockClassifyMessage = jest.fn();
const mockExtractBookingIntent = jest.fn();
const mockExtractConfirmation = jest.fn();
const mockGenerateHelpReply = jest.fn();
const mockGenerateReturningUserGreeting = jest.fn();
const mockSendWhatsAppText = jest.fn();
const mockUpsertLeadActivity = jest.fn();
const mockTrackLeadEvent = jest.fn();
const mockMarkLeadConverted = jest.fn();
const mockGetFirstStaffWithSlotsOnDate = jest.fn();
const mockInc = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
  query: mockQuery,
}));

jest.unstable_mockModule('../src/services/session.service.js', () => ({
  getSession: mockGetSession,
  updateSession: mockUpdateSession,
  resetSession: mockResetSession,
  normalizePhone: (phone) => String(phone || '').replace(/^whatsapp:/i, '').trim(),
  STATES: {
    IDLE: 'IDLE',
    AWAITING_SERVICE: 'AWAITING_SERVICE',
    AWAITING_DATE: 'AWAITING_DATE',
    AWAITING_TIME: 'AWAITING_TIME',
    AWAITING_STAFF: 'AWAITING_STAFF',
    AWAITING_NAME: 'AWAITING_NAME',
    AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
    AWAITING_CANCEL_WHICH: 'AWAITING_CANCEL_WHICH',
    AWAITING_RESCHEDULE_WHICH: 'AWAITING_RESCHEDULE_WHICH',
    AWAITING_RESCHEDULE_DATE: 'AWAITING_RESCHEDULE_DATE',
    AWAITING_RESCHEDULE_TIME: 'AWAITING_RESCHEDULE_TIME',
    AWAITING_RESCHEDULE_CONFIRM: 'AWAITING_RESCHEDULE_CONFIRM',
    AWAITING_HANDOFF: 'AWAITING_HANDOFF',
  },
}));

jest.unstable_mockModule('../src/services/appointment.service.js', () => ({
  getServices: mockGetServices,
  getStaff: mockGetStaff,
  getAvailableSlots: mockGetAvailableSlots,
  bookAppointment: mockBookAppointment,
  getUpcomingAppointments: mockGetUpcomingAppointments,
  cancelAppointment: mockCancelAppointment,
  rescheduleAppointment: mockRescheduleAppointment,
  getCustomerName: mockGetCustomerName,
  upsertCustomer: mockUpsertCustomer,
  getBusiness: mockGetBusiness,
  getBusinessByPhone: mockGetBusinessByPhone,
  getBusinessByWhatsAppPhoneNumberId: mockGetBusinessByWhatsAppPhoneNumberId,
  findService: jest.fn(),
  getAvailableSlotsForRange: jest.fn(),
  getFirstStaffWithSlotsOnDate: mockGetFirstStaffWithSlotsOnDate,
  localToUTC: jest.fn(),
  findNextSlotNearTime: jest.fn(),
  getLastBookedService: jest.fn(),
  getMostRecentAppointment: jest.fn(),
  markNextPendingAppointmentConfirmedForCustomer: jest.fn(),
}));

jest.unstable_mockModule('../src/services/ai.service.js', () => ({
  classifyMessage: mockClassifyMessage,
  extractBookingIntent: mockExtractBookingIntent,
  extractConfirmation: mockExtractConfirmation,
  generateHelpReply: mockGenerateHelpReply,
  generateReturningUserGreeting: mockGenerateReturningUserGreeting,
  answerConversational: jest.fn(),
  extractRescheduleIntent: jest.fn(),
  extractAvailabilityQuery: jest.fn(),
  generateInactivityNudge: jest.fn(),
  generateDynamicFallbackReply: jest.fn(),
}));

jest.unstable_mockModule('../src/services/whatsapp.service.js', () => ({
  sendWhatsAppText: mockSendWhatsAppText,
  sendWhatsAppTemplate: jest.fn(),
}));

jest.unstable_mockModule('../src/services/lead.service.js', () => ({
  upsertLeadActivity: mockUpsertLeadActivity,
  trackLeadEvent: mockTrackLeadEvent,
  markLeadConverted: mockMarkLeadConverted,
}));

jest.unstable_mockModule('../src/services/messaging-preference.service.js', () => ({
  setCampaignOptOut: jest.fn(),
}));

jest.unstable_mockModule('../src/services/whisper.service.js', () => ({
  transcribeMetaAudio: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/formatter.js', () => ({
  formatWelcome: jest.fn(() => 'Welcome message'),
  formatServiceList: jest.fn(() => 'Service list'),
  formatStaffList: jest.fn(() => 'Staff list'),
  formatSlotList: jest.fn(() => 'Slot list'),
  curateSlots: jest.fn((slots) => (slots || []).slice(0, 6)),
  formatConfirmationPrompt: jest.fn(() => 'Confirm booking?'),
  formatBookingConfirmed: jest.fn(() => 'Booking confirmed!'),
  formatAppointmentList: jest.fn(() => 'Your appointments'),
  formatCancellationConfirmed: jest.fn(() => 'Cancelled!'),
  formatRescheduleConfirmed: jest.fn(() => 'Rescheduled!'),
  formatAvailabilitySummary: jest.fn(() => 'Availability summary'),
  formatHandoffMessage: jest.fn(() => 'Connecting you to a human'),
  formatError: jest.fn((msg) => `Error: ${msg}`),
  formatNotUnderstood: jest.fn(() => 'I did not understand'),
  formatFriendlyFallback: jest.fn((msg) => msg),
  formatDate: jest.fn((date) => date),
  formatTime: jest.fn((time) => time),
  formatDateTime: jest.fn((dt) => dt),
  timeToMinutes: jest.fn((t) => {
    const [h, m] = String(t || '00:00').split(':').map(Number);
    return h * 60 + m;
  }),
  getTimeNotAvailableReason: jest.fn(() => 'slot is booked'),
  formatShortWhatsAppReply: jest.fn((msg) => msg),
}));

jest.unstable_mockModule('../src/utils/serviceMatch.js', () => ({
  matchServiceFromMessage: jest.fn(),
  matchServicesFromMessage: jest.fn(),
  aggregateMatchedServices: jest.fn(),
}));

jest.unstable_mockModule('../src/context/correlation.js', () => ({
  runWithCorrelation: (_id, fn) => fn(),
}));

jest.unstable_mockModule('../src/utils/metrics.js', () => ({
  inc: mockInc,
}));

const { handleMessage } = await import('../src/routes/webhook.js');

describe('handleMessage — AWAITING_TIME', () => {
  beforeAll(() => {
    jest.useFakeTimers({ advanceTimers: true });
    jest.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsertLeadActivity.mockResolvedValue(null);
    mockGetBusiness.mockResolvedValue({
      id: 1,
      name: 'Test Biz',
      timezone: 'Asia/Kolkata',
      type: 'salon',
    });
    mockGetCustomerName.mockResolvedValue(null);
    mockGetBusinessByWhatsAppPhoneNumberId.mockResolvedValue(null);
    mockGetBusinessByPhone.mockResolvedValue(null);
  });

  const baseTemp = {
    date: '2026-04-20',
    staffId: 's1',
    staffName: 'Alice',
    serviceId: 1,
    serviceName: 'Cut',
    durationMinutes: 30,
    price: 25,
    displaySlots: ['09:00', '10:00'],
  };

  test('mid-flow date change (unlocked staff): switches date, staff, and displaySlots', async () => {
    mockGetSession.mockResolvedValue({
      phone: '+1000',
      businessId: 1,
      state: 'AWAITING_TIME',
      temp: { ...baseTemp, lockStaff: false },
      timedOut: false,
      updatedAt: new Date('2026-04-18T12:00:00.000Z'),
    });
    mockGetAvailableSlots.mockResolvedValue(['09:00', '10:00', '11:00']);
    mockExtractBookingIntent.mockResolvedValueOnce({ date: '2026-04-25', time: null });
    mockGetStaff.mockResolvedValue([
      { id: 's1', name: 'Alice' },
      { id: 's2', name: 'Bob' },
    ]);
    mockGetFirstStaffWithSlotsOnDate.mockResolvedValue({
      staffId: 's2',
      staffName: 'Bob',
      slots: ['14:00', '15:00'],
    });

    const { reply } = await handleMessage({
      rawPhone: '+1000',
      message: 'How about April 25th',
      explicitBusinessId: 1,
      toNumberForRouting: '',
      leadSource: null,
      leadCampaign: null,
      leadUtmSource: null,
    });

    expect(reply).toContain('Got it');
    expect(reply).toContain('2026-04-25');
    expect(reply).toContain('Alice');
    expect(reply).toContain('Bob');
    expect(mockGetFirstStaffWithSlotsOnDate).toHaveBeenCalledWith(1, '2026-04-25', 30, 's1');
    expect(mockUpdateSession).toHaveBeenCalledWith(
      '+1000',
      1,
      'AWAITING_TIME',
      expect.objectContaining({
        date: '2026-04-25',
        staffId: 's2',
        staffName: 'Bob',
        displaySlots: ['14:00', '15:00'],
      }),
    );
  });

  test('mid-flow date change (locked staff, no slots on new day): asks for another date', async () => {
    mockGetSession.mockResolvedValue({
      phone: '+1000',
      businessId: 1,
      state: 'AWAITING_TIME',
      temp: { ...baseTemp, lockStaff: true },
      timedOut: false,
      updatedAt: new Date('2026-04-18T12:00:00.000Z'),
    });
    mockGetAvailableSlots.mockImplementation((_biz, d) => {
      if (d === '2026-04-25') return [];
      return ['09:00', '10:00'];
    });
    mockExtractBookingIntent.mockResolvedValueOnce({ date: '2026-04-25', time: null });

    const { reply } = await handleMessage({
      rawPhone: '+1000',
      message: 'Try the 25th instead',
      explicitBusinessId: 1,
      toNumberForRouting: '',
      leadSource: null,
      leadCampaign: null,
      leadUtmSource: null,
    });

    expect(reply).toContain('Alice');
    expect(reply).toContain('no slots');
    expect(mockUpdateSession).toHaveBeenCalledWith(
      '+1000',
      1,
      'AWAITING_DATE',
      expect.objectContaining({
        date: null,
        time: null,
        displaySlots: null,
      }),
    );
  });

  test('correction prefix for time: "Actually 10:00" resolves when slot exists', async () => {
    mockGetSession.mockResolvedValue({
      phone: '+1000',
      businessId: 1,
      state: 'AWAITING_TIME',
      temp: { ...baseTemp },
      timedOut: false,
      updatedAt: new Date('2026-04-18T12:00:00.000Z'),
    });
    mockGetAvailableSlots.mockResolvedValue(['09:00', '10:00', '11:00']);
    mockExtractBookingIntent
      .mockResolvedValueOnce({ date: null, time: null })
      .mockResolvedValueOnce({ date: null, time: null })
      .mockResolvedValueOnce({ date: null, time: '10:00' });
    mockGetStaff.mockResolvedValue([{ id: 's1', name: 'Alice' }]);
    mockGetCustomerName.mockResolvedValue('Sam');

    const { reply } = await handleMessage({
      rawPhone: '+1000',
      message: 'Actually 10:00',
      explicitBusinessId: 1,
      toNumberForRouting: '',
      leadSource: null,
      leadCampaign: null,
      leadUtmSource: null,
    });

    expect(reply).toBe('Confirm booking?');
    expect(mockUpdateSession).toHaveBeenCalledWith(
      '+1000',
      1,
      'AWAITING_CONFIRMATION',
      expect.objectContaining({
        time: '10:00',
        pendingBooking: expect.objectContaining({ time: '10:00', customerName: 'Sam' }),
      }),
    );
  });
});
