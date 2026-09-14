'use client';
import { createContext, useContext } from 'react';

/*
 * The brand, handed down from the server layout.
 *
 * It is read once per request there and passed in, rather than fetched by
 * every component that draws a logo — the rail, the login screen, the kitchen
 * display and the customer menu all want the same two strings, and four
 * round trips for them would be four round trips.
 */
const BrandContext = createContext({ name: 'POS', logoLight: '', logoDark: '', colour: '', tagline: '' });

export const useBrand = () => useContext(BrandContext);

export default function BrandProvider({ brand, children }) {
    return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
