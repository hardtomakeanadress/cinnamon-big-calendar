// Exit 77 means an unavailable environment, never a passing assertion.
import System from 'system';
export async function requireCalendarLibraries() {
    try {
        await import('gi://ECal?version=2.0');
        await import('gi://EDataServer?version=1.2');
        await import('gi://ICalGLib?version=3.0');
    } catch (e) {
        print('SKIP: calendar libraries unavailable: ' + e.message);
        System.exit(77);
    }
}
