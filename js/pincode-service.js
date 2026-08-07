/**
 * India Pincode Auto-Fetch Service
 * Fetches location details (City, District, State) for a 6-digit Indian Pincode
 * using the official Postal Pincode API (https://api.postalpincode.in/pincode/{pincode}).
 */

/**
 * Fetch location details for a given 6-digit Indian pincode.
 *
 * @param {string|number} pincode  6-digit Indian postal code
 * @returns {Promise<{
 *   success: boolean,
 *   pincode?: string,
 *   city?: string,
 *   district?: string,
 *   state?: string,
 *   postOffices?: Array,
 *   message?: string
 * }>}
 */
export async function fetchIndiaPincodeDetails(pincode) {
  const cleanCode = String(pincode || '').replace(/\D/g, '').trim();

  if (cleanCode.length !== 6) {
    return {
      success: false,
      message: 'Please enter a valid 6-digit Pincode.'
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

    const response = await fetch(`https://api.postalpincode.in/pincode/${cleanCode}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }

    const data = await response.json();

    if (
      Array.isArray(data) &&
      data[0] &&
      data[0].Status === 'Success' &&
      Array.isArray(data[0].PostOffice) &&
      data[0].PostOffice.length > 0
    ) {
      const office = data[0].PostOffice[0];
      const district = office.District || '';
      const state = office.State || '';
      const city = district || office.Block || office.Name || '';

      return {
        success: true,
        pincode: cleanCode,
        city: city.trim(),
        district: district.trim(),
        state: state.trim(),
        postOffices: data[0].PostOffice,
        message: `Location detected: ${city}, ${state}`
      };
    } else {
      return {
        success: false,
        message: 'Pincode not found. Please enter location manually.'
      };
    }
  } catch (err) {
    console.warn('[TBC Pincode API Notice]', err.message || err);
    return {
      success: false,
      message: 'Unable to fetch location details. Please enter manually.'
    };
  }
}
