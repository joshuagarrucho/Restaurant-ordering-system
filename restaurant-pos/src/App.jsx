import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardList,
  ChevronDown,
  Clock3,
  CircleUserRound,
  Coffee,
  Eye,
  EyeOff,
  LayoutDashboard,
  LogOut,
  LockKeyhole,
  Minus,
  Plus,
  RefreshCw,
  ReceiptText,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { isSupabaseConfigured, supabase } from './lib/supabase.js';
import {
  COUNTER_SALE_KEY,
  GUEST_CHECKOUT_KEY,
  canAccessModule,
  calculateCashPayment,
  getRpcValue,
  isPostgresErrorCode,
  normalizeStaffRole,
  normalizeGuestOrder,
  prepareCounterSaleRequest,
  prepareGuestOrderRequest,
  customizationLabels,
  customizationSelectionValid,
  customizationUnitPrice,
  orderLineKey,
  formatTableLabel,
  resolveGuestTableToken,
} from './lib/order-utils.js';
import PrintDocument from './components/PrintDocument.jsx';
import StaffOrderOperations, { useStaffOrders } from './components/StaffOrderOperations.jsx';
import AdminWorkspace from './components/AdminWorkspace.jsx';
import { documentDate } from './lib/document-utils.js';

const currency = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
});

const productPhotos = {
  Americano: 'americano.jpg',
  Cappuccino: 'cappuccino.jpg',
  'Iced Latte': 'iced-latte.jpg',
  'Iced Mocha': 'iced-mocha.jpg',
  'Butter Croissant': 'butter-croissant.jpg',
  'Chocolate Muffin': 'chocolate-muffin.jpg',
};

const GUEST_TOKEN_KEY = 'esmiringkape.guest-token';
const getErrorMessage = (error) =>
  error?.message || 'Something went wrong. Please try again.';

const getInitialGuestCheckout = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(GUEST_CHECKOUT_KEY) || 'null');
    const requestedTable = new URLSearchParams(window.location.search).get('table');
    if (requestedTable && saved?.payload?.p_table_token !== requestedTable) {
      sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
};

const getInitialGuestTableToken = () => {
  return resolveGuestTableToken(window.location.search, getInitialGuestCheckout());
};

const printDocument = (kind) => {
  document.body.dataset.printType = kind;
  window.addEventListener('afterprint', () => delete document.body.dataset.printType, { once: true });
  window.print();
};

const makeGuestToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const fetchMenuItems = async () => {
  let result = await supabase
    .from('MenuItems')
    .select('ItemID, ItemName, Price, CategoryID, Available, ImageURL')
    .order('ItemName');
  if (['42703', 'PGRST204'].includes(result.error?.code)) {
    result = await supabase
      .from('MenuItems')
      .select('ItemID, ItemName, Price, CategoryID, Available')
      .order('ItemName');
  }
  return result;
};

function ProductPhoto({ itemName, imageUrl, iconSize = 30 }) {
  const [failed, setFailed] = useState(false);
  const [useLocalFallback, setUseLocalFallback] = useState(false);
  const fileName = productPhotos[itemName] || 'cappuccino.jpg';

  if (failed) return <Coffee size={iconSize} strokeWidth={1.4} aria-hidden="true" />;

  return (
    <img
      className="product-photo-image"
      src={imageUrl && !useLocalFallback ? imageUrl : `/images/${fileName}`}



      alt={itemName}
      loading="lazy"
      onError={() => {
        if (imageUrl && !useLocalFallback) setUseLocalFallback(true);
        else setFailed(true);
      }}
    />
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [staffMode, setStaffMode] = useState(false);
  const [staffProfile, setStaffProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return undefined;
    }

    let active = true;
    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setLoginError(getErrorMessage(error));
        setSession(data.session);
        setAuthLoading(false);
      })
      .catch((error) => {
        if (!active) return;
        setLoginError(getErrorMessage(error));
        setAuthLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!staffMode || !session?.user?.id || !supabase) {
      setStaffProfile(null);
      setProfileError('');
      setProfileLoading(false);
      return undefined;
    }

    let active = true;
    setStaffProfile(null);
    setProfileLoading(true);
    setProfileError('');
    supabase.auth.getUser()
      .then(async ({ data, error }) => {
        if (error) throw error;
        if (!data.user || data.user.id !== session.user.id) {
          throw new Error('Your staff session could not be verified. Please sign in again.');
        }

        const { data: employee, error: employeeError } = await supabase
          .from('Employee')
          .select('EmployeeID, FullName, Role, EmployeeStatus, AuthUserID')
          .eq('AuthUserID', data.user.id)
          .maybeSingle();
        if (employeeError) throw employeeError;
        if (!employee || employee.EmployeeStatus !== 'Active') {
          throw new Error('An active staff profile linked to this login was not found.');
        }

        const role = normalizeStaffRole(employee.Role);
        if (!role) {
          throw new Error('This staff profile does not have an authorized role.');
        }
        if (active) setStaffProfile(employee);
      })
      .catch((error) => {
        if (active) {
          setStaffProfile(null);
          setProfileError(getErrorMessage(error));
        }
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });

    return () => {
      active = false;
    };
  }, [session?.user?.id, staffMode]);

  const signIn = async (event) => {
    event.preventDefault();
    setLoginError('');
    setAuthLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setLoginError(getErrorMessage(error));
    } catch (error) {
      setLoginError(getErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  };

  const signOut = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) setLoginError(getErrorMessage(error));
    } catch (error) {
      setLoginError(getErrorMessage(error));
    }
  };

  if (!isSupabaseConfigured) return <ConfigurationScreen />;
  if (!staffMode) return <CustomerOrdering onStaffAccess={() => setStaffMode(true)} />;
  if (authLoading) return <LoadingScreen />;
  if (!session) {
    return (
      <LoginScreen
        email={email}
        password={password}
        error={loginError}
        loading={authLoading}
        showPassword={showPassword}
        onTogglePassword={() => setShowPassword((visible) => !visible)}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onSubmit={signIn}
        onBackToMenu={() => {
          setStaffMode(false);
          setLoginError('');
        }}
      />
    );
  }

  if (profileLoading) return <LoadingScreen />;
  if (profileError || !staffProfile) {
    return <StaffAccessError error={profileError || 'Your staff profile could not be verified.'} onSignOut={signOut} />;
  }

  if (normalizeStaffRole(staffProfile.Role) === 'admin') {
    return <AdminWorkspace user={session.user} employeeProfile={staffProfile} onSignOut={signOut} PosDashboard={PosDashboard} />;
  }
  return <PosDashboard user={session.user} employeeProfile={staffProfile} authError={loginError} onSignOut={signOut} />;
}

function CustomerOrdering({ onStaffAccess }) {
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [tableToken, setTableToken] = useState(getInitialGuestTableToken);
  const [tableNumber, setTableNumber] = useState('');
  const serviceType = tableToken ? 'dine_in' : 'takeaway';
  const [customizeItem, setCustomizeItem] = useState(null);
  const [customizeSelection, setCustomizeSelection] = useState([]);
  const [customizeAvailable, setCustomizeAvailable] = useState(null);
  const [customizeAvailabilityBusy, setCustomizeAvailabilityBusy] = useState(false);
  const [storedCheckout] = useState(getInitialGuestCheckout);
  const [cart, setCart] = useState(() => {
    try {
      const requestedTable = new URLSearchParams(window.location.search).get('table');
      const saved = getInitialGuestCheckout();
      if (Array.isArray(saved?.cart)) return saved.cart;
      if (requestedTable) return [];
      const legacy = JSON.parse(sessionStorage.getItem('esmiringkape.pending-order') || 'null');
      return Array.isArray(legacy?.items) ? legacy.items : [];
    } catch {
      return [];
    }
  });
  const [pendingOrder, setPendingOrder] = useState(() => {
    const saved = getInitialGuestCheckout();
    return saved?.payload && saved?.token ? saved : null;
  });
  const [savedToken, setSavedToken] = useState(() => {
    try {
      return sessionStorage.getItem(GUEST_TOKEN_KEY) || '';
    } catch {
      return '';
    }
  });
  const [pickupName, setPickupName] = useState(() => storedCheckout?.payload?.p_guest_name || '');
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState('menu');
  const [cartOpen, setCartOpen] = useState(false);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const checkoutLock = useRef(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [successOrder, setSuccessOrder] = useState(null);
  const [trackingOrder, setTrackingOrder] = useState(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackingError, setTrackingError] = useState('');

  const loadMenu = useCallback(async () => {
    setMenuLoading(true);
    setMenuError('');
    if (tableToken) setTableNumber('');
    try {
      const menuResult = await supabase.rpc('esmiringkape_public_menu', { p_table_token: tableToken || null });
      if (menuResult.error) throw menuResult.error;
      const menu = typeof menuResult.data === 'string' ? JSON.parse(menuResult.data) : menuResult.data;
      const table = menu?.table ?? menu?.Table ?? null;
      const validatedToken = table?.public_token ?? table?.PublicToken;
      if (tableToken && (!table || String(validatedToken).toLowerCase() !== tableToken.toLowerCase())) {
        throw new Error('This table QR link is invalid or inactive. Please scan an active table QR code or ask staff for help.');
      }
      setCategories(menu?.categories ?? menu?.Categories ?? []);
      setMenuItems(menu?.items ?? menu?.Items ?? []);
      setTableNumber(tableToken ? String(table?.table_number ?? table?.TableNumber ?? '') : '');
    } catch (error) {
      setTableNumber('');
      setMenuError(getErrorMessage(error));
    } finally {
      setMenuLoading(false);
    }
  }, [tableToken]);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);
  useEffect(() => {
    const handleHistoryNavigation = () => {
      const nextToken = new URLSearchParams(window.location.search).get('table') || '';
      if (nextToken === tableToken) return;
      setTableToken(nextToken);
      setTableNumber('');
      setCheckoutError('');
      if (pendingOrder?.payload?.p_table_token !== (nextToken || undefined)) {
        setPendingOrder(null);
        setCart([]);
        try { sessionStorage.removeItem(GUEST_CHECKOUT_KEY); } catch { /* Keep the current page usable without browser storage. */ }
      }
    };
    window.addEventListener('popstate', handleHistoryNavigation);
    return () => window.removeEventListener('popstate', handleHistoryNavigation);
  }, [pendingOrder, tableToken]);

  useEffect(() => {
    if (!customizeItem) return undefined;
    if (!customizationSelectionValid(customizeItem, customizeSelection)) {
      setCustomizeAvailable(null);
      setCustomizeAvailabilityBusy(false);
      return undefined;
    }
    let active = true;
    setCustomizeAvailabilityBusy(true);
    supabase.rpc('esmiringkape_public_configuration_available', {
      p_menu_item_id: Number(customizeItem.ItemID),
      p_selected_option_ids: customizeSelection.map(Number),
    }).then(({ data, error }) => {
      if (!active) return;
      setCustomizeAvailable(!error && data === true);
    }).catch(() => {
      if (active) setCustomizeAvailable(false);
    }).finally(() => { if (active) setCustomizeAvailabilityBusy(false); });
    return () => { active = false; };
  }, [customizeItem, customizeSelection]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return menuItems.filter((item) => {
      const matchesCategory =
        activeCategory === 'all' || String(item.CategoryID) === String(activeCategory);
      return matchesCategory && (!query || item.ItemName.toLowerCase().includes(query));
    });
  }, [activeCategory, menuItems, search]);

  const unavailableItems = cart.filter((line) => {
    const item = menuItems.find((entry) => String(entry.ItemID) === String(line.ItemID));
    if (!item || item.Available !== true || (item.StockAvailable === false && !(line.selectedOptionIds || []).length)) return true;
    const chosen = new Set((line.selectedOptionIds || []).map(String));
    return (item.groups || []).some((group) => group.options.some((option) => chosen.has(String(option.option_id)) && option.available === false));
  });
  const cartTotal = Math.round(
    cart.reduce((sum, line) => sum + Number(line.unitPrice ?? line.Price ?? 0) * line.quantity, 0) * 100,
  ) / 100;
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  const updateCart = (nextCart) => {
    if (pendingOrder || checkoutBusy) return;
    setCart(nextCart);
    setCheckoutError('');
    try {
      sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
      sessionStorage.removeItem('esmiringkape.pending-order');
    } catch (error) {
      setCheckoutError(`Could not update this browser's saved order: ${getErrorMessage(error)}`);
    }
  };

  const addToCart = (item, selectedOptionIds = []) => {
    const key = orderLineKey(item.ItemID, selectedOptionIds);
    const existing = cart.find((line) => line.key === key);
    const optionLabels = customizationLabels(item, selectedOptionIds);
    const unitPrice = customizationUnitPrice(item, selectedOptionIds);
    const nextCart = existing
      ? cart.map((line) =>
        line.key === key
          ? { ...line, quantity: line.quantity + 1 }
          : line)
      : [...cart, { ...item, key, selectedOptionIds, optionLabels, unitPrice, quantity: 1 }];
    updateCart(nextCart);
    setCustomizeItem(null);
  };

  const changeQuantity = (lineKey, difference) => {
    updateCart(
      cart
        .map((line) =>
          line.key === lineKey
            ? { ...line, quantity: line.quantity + difference }
            : line)
        .filter((line) => line.quantity > 0),
    );
  };

  const startCustomization = (item) => {
    const defaults = (item.groups || []).flatMap((group) => group.options.filter((option) => option.is_default && option.available !== false).map((option) => option.option_id));
    if (!item.groups?.length) {
      addToCart(item, []);
      return;
    }
    setCustomizeSelection(defaults);
    setCustomizeAvailable(null);
    setCustomizeAvailabilityBusy(true);
    setCustomizeItem(item);
  };

  const toggleCustomization = (group, option) => {
    if (option.available === false) return;
    const selected = new Set(customizeSelection.map(String));
    const id = String(option.option_id);
    if (selected.has(id)) selected.delete(id);
    else {
      const selectedInGroup = group.options.filter((entry) => selected.has(String(entry.option_id))).length;
      if (group.selection_type === 'multiple' && selectedInGroup >= Number(group.max_selections || 1)) return;
      if (group.selection_type === 'single') group.options.forEach((entry) => selected.delete(String(entry.option_id)));
      selected.add(id);
    }
    setCustomizeAvailable(null);
    setCustomizeAvailabilityBusy(true);
    setCustomizeSelection([...selected]);
  };

  const submitGuestOrder = async () => {
    if (!cart.length || (!pendingOrder && unavailableItems.length) || checkoutLock.current) return;
    if (!pendingOrder && serviceType === 'dine_in' && (!tableToken || !tableNumber)) {
      setCheckoutError(tableToken
        ? 'This table QR link is invalid or inactive. Scan an active table QR code before placing a dine-in order.'
        : 'Scan your table’s QR code to order dine-in.');
      return;
    }
    checkoutLock.current = true;
    setCheckoutBusy(true);
    setCheckoutError('');
    let attemptedRequest = pendingOrder;
    try {
      const request = prepareGuestOrderRequest({
        storage: sessionStorage,
        pendingRequest: pendingOrder,
        cart,
        pickupName,
        serviceType,
        tableToken: serviceType === 'dine_in' ? tableToken : '',
        createToken: makeGuestToken,
      });
      attemptedRequest = request;
      sessionStorage.setItem(GUEST_TOKEN_KEY, request.token);
      setPendingOrder(request);
      setSavedToken(request.token);

      const { data, error } = await supabase.rpc('esmiringkape_create_guest_order_v2', request.payload);
      if (error) throw error;

      const order = normalizeGuestOrder(data);
      if (!order) {
        let recovered = null;
        let recoveryMessage = 'No tracking token was available.';
        try {
          const fallback = request?.payload?.p_guest_token || request?.token || savedToken || sessionStorage.getItem(GUEST_TOKEN_KEY);
          if (fallback) {
            const { data: trackedData, error: trackedError } = await supabase.rpc('esmiringkape_track_guest_order_v2', {
              p_guest_token: fallback,
            });
            if (trackedError) throw trackedError;
            recovered = normalizeGuestOrder(trackedData);
            if (!recovered) recoveryMessage = 'Tracking returned incomplete order details.';
          }
        } catch (error) {
          recoveryMessage = getErrorMessage(error);
        }

        if (!recovered) {
          throw new Error(`Order confirmation is incomplete and tracking could not verify it: ${recoveryMessage} Retry to safely resume this order.`);
        }

        setSuccessOrder(recovered);
        setCart([]);
        setPendingOrder(null);
        setCheckoutError('');
        try {
          sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
        } catch (error) {
          setCheckoutError(`Order was received, but the saved retry record could not be cleared: ${getErrorMessage(error)}`);
        }
        return;
      }

      const confirmation = { ...order, total: Number(order.total) };
      setSuccessOrder(confirmation);
      setCart([]);
      try {
        sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
      } catch (error) {
        setCheckoutError(`Order was received, but the saved retry record could not be cleared: ${getErrorMessage(error)}`);
      }
      setPendingOrder(null);
    } catch (error) {
      setCheckoutError(getErrorMessage(error));
      if (isPostgresErrorCode(error?.code)) {
        setPendingOrder(null);
        setSavedToken('');
        try {
          sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
          sessionStorage.removeItem(GUEST_TOKEN_KEY);
        } catch {
          // Keep the submitted items available even if browser storage is unavailable.
        }
        if (attemptedRequest?.cart) setCart(attemptedRequest.cart);
        setCheckoutError(`${getErrorMessage(error)} The server rejected this order. Your items are still saved; update the order or try again.`);
      }
    } finally {
      checkoutLock.current = false;
      setCheckoutBusy(false);
    }
  };

  const trackOrder = async () => {
    if (!savedToken || trackingBusy) return;
    setTrackingBusy(true);
    setTrackingError('');
    setTrackingOrder(null);
    try {
      let { data, error } = await supabase.rpc('esmiringkape_track_guest_order_v2', {
        p_guest_token: savedToken,
      });
      if (error) throw error;
      let order = normalizeGuestOrder(data);
      if (!order) {
        const legacy = await supabase.rpc('esmiringkape_track_guest_order', { p_guest_token: savedToken });
        if (legacy.error) throw legacy.error;
        order = normalizeGuestOrder(legacy.data);
      }
      if (!order) throw new Error('We could not find a matching order and tracking reference.');
      setTrackingOrder(order);
    } catch (error) {
      setTrackingError(getErrorMessage(error));
    } finally {
      setTrackingBusy(false);
    }
  };

  const cartContent = (
    <>
      <div className="customer-cart-heading">
        <div>
          <span className="customer-eyebrow">YOUR ORDER</span>
          <h2>Your Order <span className="customer-count">{cartCount}</span></h2>
        </div>
        <button className="customer-icon-button" onClick={() => updateCart([])} disabled={!cart.length || Boolean(pendingOrder) || checkoutBusy} aria-label="Clear Your Order">
          <Trash2 size={17} />
        </button>
      </div>
      <div className="customer-cart-lines">
        {cart.length ? cart.map((line) => (
          <div className="customer-cart-line" key={line.key || orderLineKey(line.ItemID, line.selectedOptionIds || [])}>
            <div className="customer-cart-product">
              <strong>{line.ItemName}</strong>
              {line.optionLabels?.length > 0 && <small className="customer-line-options">{line.optionLabels.join(' · ')}</small>}
              {unavailableItems.some((item) => String(item.ItemID) === String(line.ItemID))
                ? <span className="customer-unavailable-label">Unavailable</span>
                : <span>{currency.format(Number(line.unitPrice ?? line.Price))} each</span>}
              <div className="customer-quantity">
                <button onClick={() => changeQuantity(line.key || orderLineKey(line.ItemID, line.selectedOptionIds || []), -1)} disabled={Boolean(pendingOrder) || checkoutBusy} aria-label={`Remove one ${line.ItemName}`}><Minus size={14} /></button>
                <span>{line.quantity}</span>
                <button onClick={() => changeQuantity(line.key || orderLineKey(line.ItemID, line.selectedOptionIds || []), 1)} disabled={Boolean(pendingOrder) || checkoutBusy || unavailableItems.some((item) => String(item.ItemID) === String(line.ItemID))} aria-label={`Add one ${line.ItemName}`}><Plus size={14} /></button>
              </div>
            </div>
            <strong>{unavailableItems.some((item) => String(item.ItemID) === String(line.ItemID))
              ? '—'
              : currency.format(Number(line.unitPrice ?? line.Price) * line.quantity)}
            </strong>
          </div>
        )) : (
          <div className="customer-cart-empty">
            <ShoppingBag size={24} />
            <strong>Your order is empty</strong>
            <span>Add something from the menu.</span>
          </div>
        )}
      </div>
      <div className="customer-cart-total">
        <fieldset className="customer-service-type">
          <legend>Order type</legend>
          <strong className="customer-table-notice">{serviceType === 'dine_in' ? (tableNumber ? 'Dine-in' : 'Dine-in · Table QR not verified') : 'Takeaway'}</strong>
          {serviceType === 'takeaway' && <small className="customer-dine-in-hint">Scan your table’s QR code to order dine-in.</small>}
        </fieldset>
        <div><span>Total</span><strong>{currency.format(cartTotal)}</strong></div>
        <label className="customer-pickup-label"><span className="customer-pickup-title">Pickup name <small>optional</small></span>
          <input
            value={pendingOrder?.payload?.p_guest_name ?? pickupName}
            onChange={(event) => setPickupName(event.target.value)}
            disabled={Boolean(pendingOrder) || checkoutBusy}
            placeholder="Name for your order"
          />
        </label>
        <small>Pay at the counter. Final prices are checked by the shop before payment.</small>
        {unavailableItems.length > 0 && !pendingOrder && (
          <p className="customer-error" role="alert">A selected item is sold out or unavailable. Remove it before placing your order.</p>
        )}
        {serviceType === 'dine_in' && !tableNumber && <p className="customer-error" role="alert">{tableToken ? 'This table QR link is invalid or inactive. Scan an active table QR code before placing a dine-in order.' : 'Scan your table’s QR code to order dine-in.'}</p>}
        {checkoutError && <p className="customer-error" role="alert">{checkoutError}</p>}
        <button className="customer-primary-button" onClick={submitGuestOrder} disabled={!cart.length || (!pendingOrder && unavailableItems.length > 0) || (!pendingOrder && serviceType === 'dine_in' && !tableNumber) || checkoutBusy}>
          {checkoutBusy ? 'Submitting…' : pendingOrder ? 'Retry order' : 'Place order'}
          {!checkoutBusy && <ArrowRight size={17} />}
        </button>
      </div>
    </>
  );

  return (
    <main className="customer-app">
      <header className="customer-header">
        <a className="customer-brand" href="#" onClick={(event) => { event.preventDefault(); setPage('menu'); }}>
          <span className="customer-brand-mark"><Coffee size={19} /></span>
          <span>Esmiringkape</span>
        </a>
        <nav className="customer-nav" aria-label="Main navigation">
          <button className={page === 'menu' ? 'customer-nav-active' : ''} onClick={() => setPage('menu')}>Menu</button>
          <button className="customer-cart-nav" onClick={() => {
            if (window.matchMedia('(max-width: 760px)').matches) setCartOpen(true);
            else document.querySelector('.customer-cart-sidebar')?.scrollIntoView({ behavior: 'smooth' });
          }}>
            Your Order <span>{cartCount}</span>
          </button>
          <button className={page === 'track' ? 'customer-nav-active' : ''} onClick={() => setPage('track')}>Track Order</button>
          <button className="customer-staff-nav" onClick={onStaffAccess}><LockKeyhole size={15} /> Staff Access</button>
        </nav>
      </header>

      {tableNumber && <div className="customer-table-banner">Dining at <strong>{formatTableLabel(tableNumber)}</strong></div>}

      <div className="customer-layout">
        <section className="customer-main">
          {page === 'menu' ? (
            <>
              <div className="customer-menu-toolbar">
                <h1>Menu</h1>
                <label className="customer-search">
                  <Search size={17} />
                  <input type="search" placeholder="Search menu" value={search} onChange={(event) => setSearch(event.target.value)} />
                  {search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={15} /></button>}
                </label>
              </div>
              <div className="customer-category-list" aria-label="Filter by category">
                <button className={activeCategory === 'all' ? 'customer-category-active' : ''} onClick={() => setActiveCategory('all')}>All</button>
                {categories.map((category) => (
                  <button
                    key={category.CategoryID}
                    className={String(activeCategory) === String(category.CategoryID) ? 'customer-category-active' : ''}
                    onClick={() => setActiveCategory(category.CategoryID)}
                  >{category.CategoryName}</button>
                ))}
              </div>
              {menuError && <div className="customer-alert" role="alert"><span>{menuError}</span><button onClick={loadMenu}>Try again</button></div>}
              {menuLoading ? (
                <div className="customer-state" role="status">Loading menu…</div>
              ) : menuError ? null : filteredItems.length ? (
                <div className="customer-menu-grid">
                  {filteredItems.map((item, index) => {
                    const category = categories.find((entry) => String(entry.CategoryID) === String(item.CategoryID));
                    return (
                      <article className={`customer-product product-tone-${index % 4}`} key={item.ItemID}>
                        <div className="customer-product-art">
                      <ProductPhoto itemName={item.ItemName} imageUrl={item.ImageURL || item.ImageUrl || item.ImagePath || item.image_url} />
                          <div className="customer-product-overlay">
                            <span className="customer-product-category">{category?.CategoryName || 'Menu'}</span>
                            <h2>{item.ItemName}</h2>
                            <strong>{item.groups?.length ? `From ${currency.format(Number(item.Price))}` : currency.format(Number(item.Price))}</strong>
                          <span className={`customer-product-availability ${item.Available !== true || (item.StockAvailable === false && !item.groups?.length) ? 'customer-product-unavailable' : ''}`}>{item.Available !== true ? 'Unavailable' : item.StockAvailable === false ? item.groups?.length ? 'Choose options to check stock' : 'Sold out' : 'Available'}</span>
                          </div>
                        </div>
                        <div className="customer-product-copy">
                          <button aria-label={`${item.groups?.length ? 'Customize' : 'Add'} ${item.ItemName}`} onClick={() => startCustomization(item)} disabled={item.Available !== true || (item.StockAvailable === false && !item.groups?.length) || Boolean(pendingOrder) || checkoutBusy}>{item.groups?.length ? 'Customize' : <Plus size={17} />}</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="customer-state">{menuItems.length ? 'No items match your search.' : 'No available menu items.'}</div>
              )}
            </>
          ) : (
            <section className="customer-track-page">
              <span className="customer-eyebrow">ORDER STATUS</span>
              <h1>Track Order</h1>
              <p>View the status of an order placed in this browser session.</p>
              {savedToken ? (
                <button className="customer-primary-button" onClick={trackOrder} disabled={trackingBusy}>
                  {trackingBusy ? 'Checking…' : 'Refresh order status'} <RefreshCw size={16} />
                </button>
              ) : (
                <p className="customer-track-empty">No order is saved in this browser session.</p>
              )}
              {trackingError && <p className="customer-error" role="alert">{trackingError}</p>}
              {trackingOrder && (
                <div className="customer-track-result" role="status">
                  <span><ClipboardList size={18} /> Ticket #{trackingOrder.orderNumber}</span>
                  {getRpcValue(trackingOrder, 'status', 'Status') && <strong>{getRpcValue(trackingOrder, 'status', 'Status')}</strong>}
                  {getRpcValue(trackingOrder, 'payment_status', 'PaymentStatus') && <small>Payment: {getRpcValue(trackingOrder, 'payment_status', 'PaymentStatus')}</small>}
                  {getRpcValue(trackingOrder, 'total', 'Total') != null && <small>Total: {currency.format(Number(getRpcValue(trackingOrder, 'total', 'Total')))}</small>}
                  {trackingOrder.serviceType && <small>{trackingOrder.serviceType === 'dine_in' ? `Dine-in · ${formatTableLabel(trackingOrder.tableNumber)}` : 'Takeaway'}</small>}
                  {trackingOrder.createdAt && <small>Placed {documentDate(trackingOrder.createdAt)}</small>}
                  <button className="customer-secondary-button" onClick={() => printDocument('ticket')}><ReceiptText size={15} /> Print Ticket</button>
                  <PrintDocument order={trackingOrder} />
                </div>
              )}
            </section>
          )}
        </section>

        <aside className="customer-cart-sidebar">{cartContent}</aside>
      </div>

      <footer className="customer-footer">Esmiringkape <span>·</span> Payment at the counter</footer>

      {cartOpen && (
        <div className="customer-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCartOpen(false)}>
          <section className="customer-cart-drawer" role="dialog" aria-modal="true" aria-label="Your Order">
            <button className="customer-drawer-close" onClick={() => setCartOpen(false)} aria-label="Close order"><X size={20} /></button>
            {cartContent}
          </section>
        </div>
      )}
      {successOrder && (
        <div className="customer-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSuccessOrder(null)}>
          <section className="customer-success-card" role="dialog" aria-modal="true" aria-label="Order confirmation">
            <button className="customer-drawer-close" onClick={() => setSuccessOrder(null)} aria-label="Close confirmation"><X size={20} /></button>
            <span className="customer-success-icon"><CheckCircle2 size={27} /></span>
            <span className="customer-eyebrow">ORDER RECEIVED</span>
            <h2>Ticket #{successOrder.orderNumber}</h2>
            <p>{successOrder.serviceType === 'dine_in' ? `Dine-in · ${formatTableLabel(successOrder.tableNumber || tableNumber)}` : 'Takeaway'}</p>
            <p>Total: <strong>{currency.format(successOrder.total)}</strong></p>
            <p>Payment: <strong>{getPaymentLabel(successOrder.paymentStatus)}</strong></p>
            {successOrder.items.length > 0 && (
              <div className="customer-confirmation-items">
                {successOrder.items.map((item, index) => {
                  const name = getRpcValue(item, 'item_name', 'ItemName', 'name') || 'Item';
                  const quantity = Number(getRpcValue(item, 'quantity', 'Quantity') || 0);
                  const price = Number(getRpcValue(item, 'price', 'Price', 'unit_price', 'UnitPrice') || 0);
                  const lineTotal = getRpcValue(item, 'subtotal', 'Subtotal', 'line_total');
                  const selected = getRpcValue(item, 'selected_options', 'SelectedOptions') || [];
                  const optionLabels = Array.isArray(selected) ? selected.map((option) => typeof option === 'string' ? option : `${option.group_name || 'Option'}: ${option.name || ''}`) : [];
                  return (
                    <div key={`${name}-${index}`}>
                      <span>{name} × {quantity}{optionLabels.length > 0 && <small className="customer-line-options">{optionLabels.join(' · ')}</small>}</span>
                      <strong>{currency.format(lineTotal == null ? price * quantity : Number(lineTotal))}</strong>
                    </div>
                  );
                })}
              </div>
            )}
            <small>Order tracking is available from this browser session.</small>
            <PrintDocument order={successOrder} />
            <button className="customer-secondary-button" onClick={() => printDocument('ticket')}>
              Print Ticket <ReceiptText size={16} />
            </button>
            <button className="customer-primary-button" onClick={() => { setSuccessOrder(null); setPage('track'); }}>
              Track this order <ArrowRight size={17} />
            </button>
          </section>
        </div>
      )}
      {customizeItem && (
        <div className="customer-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCustomizeItem(null)}>
          <section className="customer-success-card customer-customize-card" role="dialog" aria-modal="true" aria-label={`Customize ${customizeItem.ItemName}`}>
            <button className="customer-drawer-close" onClick={() => setCustomizeItem(null)} aria-label="Close customization"><X size={20} /></button>
            <span className="customer-eyebrow">MAKE IT YOURS</span>
            <h2>{customizeItem.ItemName}</h2>
            {(customizeItem.groups || []).map((group) => (
              <fieldset className="customer-customization-group" key={group.group_id}>
                <legend>{group.name}{group.required ? ' · Required' : ' · Optional'}</legend>
                {group.min_selections > 0 && <small className="customer-customization-help">Choose at least {group.min_selections}{group.max_selections > group.min_selections ? `, up to ${group.max_selections}` : ''}.</small>}
                {group.options.map((option) => {
                  const checked = customizeSelection.map(String).includes(String(option.option_id));
                  return (
                    <button
                      type="button"
                      key={option.option_id}
                      className={`customer-customization-option ${checked ? 'selected' : ''}`}
                      aria-pressed={checked}
                      disabled={option.available === false}
                      onClick={() => toggleCustomization(group, option)}
                    >
                      <span>{option.name}{option.available === false ? ' · Sold out' : ''}</span>
                      <strong>{Number(option.price_delta) > 0 ? `+${currency.format(Number(option.price_delta))}` : Number(option.price_delta) < 0 ? `−${currency.format(Math.abs(Number(option.price_delta)))}` : 'Included'}</strong>
                    </button>
                  );
                })}
              </fieldset>
            ))}
            <div className="customer-customization-price"><span>Price before adding</span><strong>{currency.format(customizationUnitPrice(customizeItem, customizeSelection))}</strong></div>
            <button className="customer-primary-button" onClick={() => addToCart(customizeItem, customizeSelection)} disabled={!customizationSelectionValid(customizeItem, customizeSelection) || customizeItem.Available !== true || customizeAvailable !== true || customizeAvailabilityBusy}>
              {customizeAvailabilityBusy ? 'Checking stock…' : customizeAvailable === false ? 'Sold out for this choice' : 'Add to Your Order'} <Plus size={17} />
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function getPaymentLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  return ['pending', 'unpaid', 'awaiting payment', 'due'].includes(value)
    ? 'Awaiting Payment'
    : status || 'Awaiting Payment';
}

function ConfigurationScreen() {
  return (
    <main className="login-page">
      <div className="login-card setup-card">
        <Brand />
        <span className="eyebrow">One quick setup step</span>
        <h1>Connect your shop</h1>
        <p className="muted">
          Add your Supabase project URL and anon key to <code>.env</code> in
          the <code>restaurant-pos</code> folder, then restart the dev server.
        </p>
        <pre>VITE_SUPABASE_URL=...{'\n'}VITE_SUPABASE_ANON_KEY=...</pre>
      </div>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="login-page">
      <div className="loading-mark">
        <Coffee size={24} />
        <span>Warming up the espresso machine…</span>
      </div>
    </main>
  );
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-mark">
        <Coffee size={compact ? 19 : 23} strokeWidth={2} />
      </span>
      <span className="brand-name">
        <strong>Esmiringkape</strong>
        {!compact && <small>COFFEE · COMMUNITY · COMFORT</small>}
      </span>
    </div>
  );
}

function StaffAccessError({ error, onSignOut }) {
  return (
    <main className="login-page">
      <section className="login-card">
        <Brand />
        <h1>Staff access unavailable</h1>
        <p className="form-error" role="alert">{error}</p>
        <button className="button button-primary login-submit" onClick={onSignOut}>Sign out</button>
      </section>
    </main>
  );
}

function LoginScreen({
  email,
  password,
  showPassword,
  onTogglePassword,
  error,
  loading,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onBackToMenu,
}) {
  return (
    <main className="login-page login-page-minimal">
      <section className="login-card">
        <Brand />
        <form className="login-form" onSubmit={onSubmit}>
          <label htmlFor="staff-email">
            Email
            <input
              id="staff-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              required
            />
          </label>
          <label htmlFor="staff-password">
            Password
            <span className="password-field">
              <input
                id="staff-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                required
              />
              <button type="button" className="password-toggle" onClick={onTogglePassword} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary login-submit" disabled={loading} type="submit">
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </section>
    </main>
  );
}

function PosDashboard({ user, employeeProfile, authError, onSignOut, onReturnToAdmin }) {
  const role = normalizeStaffRole(employeeProfile.Role);
  const [staffView, setStaffView] = useState(role === 'barista' ? 'queue' : 'pos');
  const staffOrders = useStaffOrders(staffView === 'orders' || staffView === 'queue');
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [savedCounterSale, setSavedCounterSale] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(COUNTER_SALE_KEY) || 'null'); } catch { return null; }
  });
  const [employee, setEmployee] = useState(employeeProfile);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [diningTables, setDiningTables] = useState([]);
  const [serviceType, setServiceType] = useState(savedCounterSale?.payload?.p_service_type || 'takeaway');
  const [diningTableId, setDiningTableId] = useState(String(savedCounterSale?.payload?.p_dining_table_id || ''));
  const [customizeItem, setCustomizeItem] = useState(null);
  const [customizeSelection, setCustomizeSelection] = useState([]);
  const [customizeAvailable, setCustomizeAvailable] = useState(null);
  const [customizeAvailabilityBusy, setCustomizeAvailabilityBusy] = useState(false);
  const [cart, setCart] = useState(() => Array.isArray(savedCounterSale?.cart) ? savedCounterSale.cart : []);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [customerSaving, setCustomerSaving] = useState(false);
  const [customerError, setCustomerError] = useState('');
  const [customerDraft, setCustomerDraft] = useState({
    FullName: '',
    Phone: '',
    Email: '',
    Address: '',
  });
  const [showCheckout, setShowCheckout] = useState(false);
  const [cashTendered, setCashTendered] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [checkoutRequest, setCheckoutRequest] = useState(savedCounterSale);
  const [saleQuote, setSaleQuote] = useState(null);
  const [saleResult, setSaleResult] = useState(null);
  const saleLock = useRef(false);

  const loadData = useCallback(async () => {
    setDataLoading(true);
    setDataError('');
    try {
      const [menuResult, tablesResult, customersResult] =
        await Promise.all([
          supabase.rpc('esmiringkape_public_menu', { p_table_token: null }),
          supabase.rpc('esmiringkape_public_tables'),
          supabase
            .from('customers')
            .select('customerID, FullName, Phone, Email, Address')
            .order('FullName'),
        ]);

      const firstError =
        menuResult.error ||
        tablesResult.error ||
        customersResult.error;
      if (firstError) throw firstError;
      setEmployee(employeeProfile);
      const menu = typeof menuResult.data === 'string' ? JSON.parse(menuResult.data) : menuResult.data;
      setCategories(menu?.categories || []);
      setMenuItems(menu?.items || []);
      setDiningTables(Array.isArray(tablesResult.data) ? tablesResult.data : []);
      setCustomers(customersResult.data || []);
    } catch (error) {
      setDataError(getErrorMessage(error));
    } finally {
      setDataLoading(false);
    }
  }, [employeeProfile]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!customizeItem) return undefined;
    if (!customizationSelectionValid(customizeItem, customizeSelection)) {
      setCustomizeAvailable(null);
      setCustomizeAvailabilityBusy(false);
      return undefined;
    }
    let active = true;
    setCustomizeAvailabilityBusy(true);
    supabase.rpc('esmiringkape_public_configuration_available', {
      p_menu_item_id: Number(customizeItem.ItemID), p_selected_option_ids: customizeSelection.map(Number),
    }).then(({ data, error }) => {
      if (active) setCustomizeAvailable(!error && data === true);
    }).catch(() => { if (active) setCustomizeAvailable(false); }).finally(() => { if (active) setCustomizeAvailabilityBusy(false); });
    return () => { active = false; };
  }, [customizeItem, customizeSelection]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return menuItems.filter((item) => {
      const matchesCategory =
        activeCategory === 'all' ||
        String(item.CategoryID) === String(activeCategory);
      const matchesSearch = !query || item.ItemName.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, menuItems, search]);

  const subtotal = Math.round(
    cart.reduce((sum, line) => sum + Number(line.unitPrice ?? line.Price) * line.quantity, 0) * 100,
  ) / 100;
  const total = subtotal;
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const selectedCustomer =
    customers.find((customer) => String(customer.customerID) === selectedCustomerId) ||
    null;

  const addToCart = (item, selectedOptionIds = []) => {
    if (item.Available !== true || (item.StockAvailable === false && !item.groups?.length) || checkoutRequest) return;
    setNotice('');
    setCustomizeItem(null);
    const key = orderLineKey(item.ItemID, selectedOptionIds);
    const unitPrice = customizationUnitPrice(item, selectedOptionIds);
    const optionLabels = customizationLabels(item, selectedOptionIds);
    setCart((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) {
        return current.map((line) =>
          line.key === key
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [...current, { ...item, key, selectedOptionIds, optionLabels, unitPrice, quantity: 1 }];
    });
  };

  const changeQuantity = (lineKey, difference) => {
    setCart((current) =>
      current
        .map((line) =>
          (line.key || orderLineKey(line.ItemID, line.selectedOptionIds || [])) === lineKey
            ? { ...line, quantity: line.quantity + difference }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  };

  const startCustomization = (item) => {
    const defaults = (item.groups || []).flatMap((group) => group.options.filter((option) => option.is_default && option.available !== false).map((option) => option.option_id));
    if (!item.groups?.length) return addToCart(item, []);
    setCustomizeSelection(defaults);
    setCustomizeAvailable(null);
    setCustomizeAvailabilityBusy(true);
    setCustomizeItem(item);
  };
  const toggleCustomization = (group, option) => {
    if (option.available === false) return;
    const selected = new Set(customizeSelection.map(String));
    const id = String(option.option_id);
    if (selected.has(id)) selected.delete(id);
    else {
      const selectedInGroup = group.options.filter((entry) => selected.has(String(entry.option_id))).length;
      if (group.selection_type === 'multiple' && selectedInGroup >= Number(group.max_selections || 1)) return;
      if (group.selection_type === 'single') group.options.forEach((entry) => selected.delete(String(entry.option_id)));
      selected.add(id);
    }
    setCustomizeAvailable(null);
    setCustomizeAvailabilityBusy(true);
    setCustomizeSelection([...selected]);
  };

  const createCustomer = async (event) => {
    event.preventDefault();
    setCustomerSaving(true);
    setCustomerError('');
    try {
      const { data, error } = await supabase
        .from('customers')
        .insert({
          FullName: customerDraft.FullName.trim(),
          Phone: customerDraft.Phone.trim() || null,
          Email: customerDraft.Email.trim() || null,
          Address: customerDraft.Address.trim() || null,
        })
        .select('customerID, FullName, Phone, Email, Address')
        .single();
      if (error) throw error;

      setCustomers((current) => [...current, data].sort((a, b) => a.FullName.localeCompare(b.FullName)));
      setSelectedCustomerId(String(data.customerID));
      setCustomerDraft({ FullName: '', Phone: '', Email: '', Address: '' });
      setShowCustomerForm(false);
    } catch (error) {
      setCustomerError(getErrorMessage(error));
    } finally {
      setCustomerSaving(false);
    }
  };

  const startCheckout = async () => {
    const saved = checkoutRequest || savedCounterSale;
    if (!cart.length && !saved) return;
    if (!saved && serviceType === 'dine_in' && !diningTableId) {
      setCheckoutError('Choose an active table before taking payment for a dine-in order.');
      return;
    }
    if (!cart.length && Array.isArray(saved?.cart)) setCart(saved.cart);
    setCheckoutError('');
    if (saved) {
      setSaleQuote({ total: Number(saved.amountDue) });
      setCashTendered(String(saved.payload.p_cash_tendered));
    } else {
      const { data, error } = await supabase.rpc('esmiringkape_quote_counter_sale_v2', {
        p_items: cart.map((line) => ({ item_id: line.ItemID, quantity: line.quantity, selected_option_ids: line.selectedOptionIds || [] })),
      });
      if (error) {
        setCheckoutError(getErrorMessage(error));
        return;
      }
      setSaleQuote(data);
      setCashTendered(Number(data.total).toFixed(2));
    }
    setShowCheckout(true);
  };

  const completeCheckout = async (event) => {
    event.preventDefault();
    if (saleLock.current) return;
    saleLock.current = true;
    setCheckoutError('');
    setCheckoutBusy(true);
    const existingRequest = checkoutRequest || savedCounterSale;
    const amountDue = Number(existingRequest?.amountDue ?? saleQuote?.total ?? total);
    const tenderedValue = existingRequest?.payload?.p_cash_tendered ?? cashTendered;
    const payment = calculateCashPayment(amountDue, tenderedValue);
    if (!payment) {
      setCheckoutError('Cash received must cover the total due.');
      setCheckoutBusy(false);
      saleLock.current = false;
      return;
    }
    if (!employee?.EmployeeID) {
      setCheckoutError('Your cashier profile is not linked to an Employee record.');
      setCheckoutBusy(false);
      saleLock.current = false;
      return;
    }

    try {
      const request = prepareCounterSaleRequest({
        storage: sessionStorage,
        pendingRequest: existingRequest,
        items: cart,
        customerId: selectedCustomer?.customerID ?? null,
        pickupName: selectedCustomer?.FullName || '',
        cashTendered: tenderedValue,
        amountDue,
        serviceType,
        diningTableId: serviceType === 'dine_in' ? diningTableId : '',
        createToken: () => crypto.randomUUID(),
      });
      setCheckoutRequest(request);
      const { data, error } = await supabase.rpc('esmiringkape_complete_counter_sale_v2', request.payload);
      if (error) throw error;
      const order = normalizeGuestOrder(data);
      if (!order) throw new Error('The sale could not be confirmed by the server. Retry to safely resume this sale.');
      const confirmedSale = {
        ...order,
        orderNumber: order.orderNumber ?? order.orderId,
        ticketNumber: order.orderNumber ?? order.orderId,
        createdAt: order.createdAt || new Date().toISOString(),
        guestName: order.guestName || selectedCustomer?.FullName || null,
        cashier: order.cashier || cashierName,
        paymentMethod: order.paymentMethod || 'Cash',
        amountPaid: Number(order.amountPaid ?? order.total),
        cashTendered: Number(order.cashTendered ?? payment.cashTendered),
        changeGiven: Number(order.changeGiven ?? payment.changeGiven),
        items: order.items?.length ? order.items : cart.map((line) => ({
          ItemName: line.ItemName,
          Quantity: line.quantity,
          UnitPrice: line.Price,
          LineTotal: Number(line.Price) * line.quantity,
        })),
      };
      setSaleResult(confirmedSale);
      setNotice(`Ticket #${confirmedSale.orderNumber} paid. Change: ${currency.format(confirmedSale.changeGiven)}`);
      setCart([]);
      setSelectedCustomerId('');
      setCheckoutRequest(null);
      setSavedCounterSale(null);
      sessionStorage.removeItem(COUNTER_SALE_KEY);
      setShowCheckout(false);
    } catch (error) {
      setCheckoutError(getErrorMessage(error));
      if (isPostgresErrorCode(error?.code)) {
        // A PostgreSQL SQLSTATE means the server transaction rolled back.
        // Clear the request so staff can correct stock or tender and start a fresh sale.
        sessionStorage.removeItem(COUNTER_SALE_KEY);
        setCheckoutRequest(null);
        setSavedCounterSale(null);
        setCheckoutError(`${getErrorMessage(error)} The sale was not recorded. Correct the issue and retry.`);
      }
    } finally {
      setCheckoutBusy(false);
      saleLock.current = false;
    }
  };

  const receiveOrderPayment = async (order, amount) => {
    const orderId = order.orderId ?? order.order_id;
    setBusyOrderId(orderId);
    try {
      const { error } = await supabase.rpc('esmiringkape_confirm_cash_payment', {
        p_order_id: Number(orderId),
        p_cash_tendered: amount,
      });
      if (error) throw error;
      setNotice(`Ticket #${order.orderNumber ?? orderId} paid.`);
      await staffOrders.reload();
    } catch (error) {
      setDataError(error.message || 'Payment could not be confirmed.');
    } finally {
      setBusyOrderId(null);
    }
  };

  const updatePreparationStatus = async (order, status) => {
    const orderId = order.orderId ?? order.order_id;
    setBusyOrderId(orderId);
    try {
      const { error } = await supabase.rpc('esmiringkape_update_preparation_status', {
        p_order_id: Number(orderId),
        p_status: status,
      });
      if (error) throw error;
      await staffOrders.reload();
    } catch (error) {
      setDataError(error.message || 'Order status could not be updated.');
    } finally {
      setBusyOrderId(null);
    }
  };

  const claimNextOrder = async () => {
    setBusyOrderId('claim-next');
    try {
      const { data, error } = await supabase.rpc('esmiringkape_claim_next_order');
      if (error) throw error;
      if (!data) setNotice('No paid waiting orders are ready to claim.');
      else setNotice(`Ticket #${data.ticket_number ?? data.order_id} is now Preparing.`);
      await staffOrders.reload();
    } catch (error) {
      setDataError(error.message || 'The next ticket could not be claimed.');
    } finally {
      setBusyOrderId(null);
    }
  };

  const cashierName =
    employee?.FullName || user.email?.split('@')[0] || 'Cashier';

  return (
    <main className="pos-shell">
      <aside className="sidebar">
        <Brand compact />
        <div className="sidebar-rule" />
        <div className="sidebar-label">STAFF MODULES</div>
        {role === 'admin' && onReturnToAdmin && <button className="nav-item" onClick={onReturnToAdmin}><LayoutDashboard size={18} /><span>Admin modules</span></button>}
        {canAccessModule(role, 'pos') && <button className={`nav-item ${staffView === 'pos' ? 'nav-item-active' : ''}`} onClick={() => setStaffView('pos')}><ShoppingBag size={18} /><span>Point of sale</span></button>}
        {canAccessModule(role, 'orders') && <button className={`nav-item ${staffView === 'orders' ? 'nav-item-active' : ''}`} onClick={() => setStaffView('orders')}><ClipboardList size={18} /><span>Orders</span></button>}
        {canAccessModule(role, 'queue') && <button className={`nav-item ${staffView === 'queue' ? 'nav-item-active' : ''}`} onClick={() => setStaffView('queue')}><Clock3 size={18} /><span>FIFO queue</span></button>}
        <div className="sidebar-bottom">
          <div className="shop-status"><span /> Register open</div>
          <button className="cashier-profile" onClick={onSignOut} title="Sign out">
            <span className="avatar">{cashierName.slice(0, 1).toUpperCase()}</span>
            <span className="cashier-meta">
              <strong>{cashierName}</strong>
              <small>{employee?.Role || 'Cashier'}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">ESMIRINGKAPE · {role?.toUpperCase()}</span>
            <h1>{staffView === 'pos' ? 'Point of sale' : staffView === 'queue' ? 'FIFO queue' : 'Orders'}</h1>
          </div>
          <div className="topbar-right">
            <div className="today-pill"><span /> Today’s service</div>
            <div className="topbar-date">
              {new Intl.DateTimeFormat('en-PH', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              }).format(new Date())}
            </div>
          </div>
        </header>

        {staffView === 'pos' ? <div className="pos-content">
          <section className="menu-column">
            {authError && (
              <div className="inline-alert" role="alert">{authError}</div>
            )}
            <div className="welcome-banner">
              <div>
                <span className="banner-kicker">A little cup of happy ☕</span>
                <h2>What can we brew for you?</h2>
                <p>Freshly made, just the way you like it.</p>
              </div>
              <div className="banner-art"><Coffee size={80} strokeWidth={1.2} /></div>
            </div>

            <div className="menu-toolbar">
              <div>
                <span className="eyebrow">THE MENU</span>
                <h2>Find your favorite</h2>
              </div>
              <label className="search-box">
                <Search size={17} />
                <input
                  type="search"
                  placeholder="Search drinks & bites"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <SlidersHorizontal size={16} className="search-filter-icon" />
              </label>
            </div>

            <div className="category-tabs" role="tablist" aria-label="Menu categories">
              <button
                className={`category-tab ${activeCategory === 'all' ? 'category-tab-active' : ''}`}
                onClick={() => setActiveCategory('all')}
              >
                All
              </button>
              {categories.map((category) => (
                <button
                  key={category.CategoryID}
                  className={`category-tab ${String(activeCategory) === String(category.CategoryID) ? 'category-tab-active' : ''}`}
                  onClick={() => setActiveCategory(category.CategoryID)}
                >
                  {category.CategoryName}
                </button>
              ))}
            </div>

            {dataError && (
              <div className="inline-alert" role="alert">
                <span>{dataError}</span>
                <button className="text-button" onClick={loadData}>Try again</button>
              </div>
            )}
            {employee && employee.EmployeeStatus !== 'Active' && (
              <div className="inline-alert" role="alert">
                This employee profile is marked {employee.EmployeeStatus}.
              </div>
            )}

            {dataLoading ? (
              <div className="menu-empty">Loading today’s menu…</div>
            ) : !employee ? (
              <div className="menu-empty menu-empty-warning">
                <CircleUserRound size={25} />
                <strong>Cashier profile not found</strong>
                <span>Ask an administrator to link your auth user to an Employee record.</span>
              </div>
      ) : dataError ? null : filteredItems.length ? (
              <div className="menu-grid">
                {filteredItems.map((item, index) => {
                  const category = categories.find(
                    (entry) => String(entry.CategoryID) === String(item.CategoryID),
                  );
                  return (
                    <button
                      className={`menu-card product-tone-${index % 4}`}
                      key={item.ItemID}
                       onClick={() => startCustomization(item)}
                       disabled={item.Available !== true || (item.StockAvailable === false && !item.groups?.length) || Boolean(checkoutRequest)}
                    >
                      <div className="product-art">
                        <span className="product-category">{category?.CategoryName || 'Freshly made'}</span>
                        <ProductPhoto itemName={item.ItemName} imageUrl={item.ImageURL || item.ImageUrl || item.ImagePath || item.image_url} iconSize={40} />
                         {(item.Available !== true || (item.StockAvailable === false && !item.groups?.length)) && <span className="product-unavailable">{item.Available !== true ? 'Unavailable' : 'Sold out'}</span>}
                         <span className="add-product">{item.groups?.length ? 'Customize' : <Plus size={17} />}</span>
                      </div>
                      <div className="product-details">
                        <strong>{item.ItemName}</strong>
                         <span>{item.groups?.length ? `From ${currency.format(Number(item.Price))}` : currency.format(Number(item.Price))}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="menu-empty">
                {menuItems.length ? 'No menu items match your search.' : 'No available menu items yet.'}
              </div>
            )}
          </section>

          <aside className="cart-panel">
            <div className="cart-heading">
              <div>
                <span className="eyebrow">YOUR ORDER</span>
                <h2>Your Order <span className="cart-count">{cartCount}</span></h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setCart([])}
                disabled={!cart.length || Boolean(checkoutRequest)}
                aria-label="Clear order"
                title="Clear order"
              >
                <Trash2 size={17} />
              </button>
            </div>

            <div className="customer-picker">
              <div className="customer-label">
                <span><CircleUserRound size={16} /> Customer <small>· optional</small></span>
                <button
                  className="text-button add-customer-button"
                  onClick={() => {
                    setCustomerError('');
                    setShowCustomerForm(true);
                  }}
                  disabled={Boolean(checkoutRequest)}
                >
                  <UserPlus size={15} /> New
                </button>
              </div>
              <div className="select-wrap">
                <select
                  value={selectedCustomerId}
                  onChange={(event) => setSelectedCustomerId(event.target.value)}
                  disabled={Boolean(checkoutRequest)}
                >
                  <option value="">Walk-in customer</option>
                  {customers.map((customer) => (
                    <option key={customer.customerID} value={customer.customerID}>
                      {customer.FullName}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} />
              </div>
            </div>

            <div className="customer-picker order-type-picker">
              <div className="customer-label"><span>Order type</span></div>
              <div className="service-choice-buttons"><button type="button" className={serviceType === 'dine_in' ? 'selected' : ''} disabled={Boolean(checkoutRequest)} onClick={() => setServiceType('dine_in')}>Dine-in</button><button type="button" className={serviceType === 'takeaway' ? 'selected' : ''} disabled={Boolean(checkoutRequest)} onClick={() => { setServiceType('takeaway'); setDiningTableId(''); }}>Takeaway</button></div>
              {serviceType === 'dine_in' && <label className="customer-pickup-label"><span className="customer-pickup-title">Dining table</span><select value={diningTableId} onChange={(event) => setDiningTableId(event.target.value)} disabled={Boolean(checkoutRequest)}><option value="">Choose table</option>{diningTables.map((table) => <option key={table.table_id} value={table.table_id}>{formatTableLabel(table.table_number)}</option>)}</select></label>}
            </div>

            <div className="cart-items">
              {cart.length ? cart.map((line) => (
                <div className="cart-line" key={line.key || orderLineKey(line.ItemID, line.selectedOptionIds || [])}>
                  <div className="cart-item-art"><Coffee size={19} /></div>
                  <div className="cart-item-main">
                    <strong>{line.ItemName}</strong>
                    {line.optionLabels?.length > 0 && <small className="cart-line-options">{line.optionLabels.join(' · ')}</small>}
                    <span>{currency.format(Number(line.unitPrice ?? line.Price))} each</span>
                    <div className="quantity-control">
                      <button
                        onClick={() => changeQuantity(line.key || orderLineKey(line.ItemID, line.selectedOptionIds || []), -1)}
                        disabled={Boolean(checkoutRequest)}
                        aria-label={`Decrease ${line.ItemName} quantity`}
                      ><Minus size={13} /></button>
                      <span>{line.quantity}</span>
                      <button
                        onClick={() => changeQuantity(line.key || orderLineKey(line.ItemID, line.selectedOptionIds || []), 1)}
                        disabled={Boolean(checkoutRequest)}
                        aria-label={`Increase ${line.ItemName} quantity`}
                      ><Plus size={13} /></button>
                    </div>
                  </div>
                  <strong className="line-total">{currency.format(Number(line.unitPrice ?? line.Price) * line.quantity)}</strong>
                </div>
              )) : (
                <div className="empty-cart">
                  <div className="empty-cart-icon"><ShoppingBag size={23} /></div>
                  <strong>Your cup is empty</strong>
                  <span>Add a drink or bite to start an order.</span>
                </div>
              )}
            </div>

            <div className="cart-summary">
              <div><span>Subtotal</span><strong>{currency.format(subtotal)}</strong></div>
              <div className="summary-total"><span>Total due</span><strong>{currency.format(total)}</strong></div>
              <button
                className="button button-primary checkout-button"
                onClick={startCheckout}
                disabled={!cart.length || dataLoading || !employee || employee.EmployeeStatus !== 'Active' || Boolean(checkoutRequest) || (serviceType === 'dine_in' && !diningTableId)}
              >
                Continue to payment <ArrowRight size={17} />
              </button>
              {checkoutRequest && (
                <button
                  className="text-button resume-checkout"
                  onClick={() => {
                    if (!cart.length && checkoutRequest.cart) setCart(checkoutRequest.cart);
                    setCashTendered(String(checkoutRequest.payload.p_cash_tendered));
                    setCheckoutError('');
                    setShowCheckout(true);
                  }}
                >
                  Resume sale
                </button>
              )}
              {notice && <div className="success-note" role="status"><Check size={15} />{notice}</div>}
            </div>
          </aside>
        </div> : (
          <StaffOrderOperations
            orders={staffOrders.orders}
            queue={staffOrders.queue}
            loading={staffOrders.loading}
            error={staffOrders.error}
            onRefresh={staffOrders.reload}
            onPayment={receiveOrderPayment}
            onStatus={updatePreparationStatus}
            onClaimNext={claimNextOrder}
            busyOrderId={busyOrderId}
            role={role}
            queueMode={staffView === 'queue'}
          />
        )}
      </section>

      {customizeItem && (
        <Modal title={`Customize ${customizeItem.ItemName}`} onClose={() => setCustomizeItem(null)}>
          <div className="modal-form">
            {(customizeItem.groups || []).map((group) => <fieldset className="customer-customization-group" key={group.group_id}><legend>{group.name}{group.required ? ' · Required' : ' · Optional'}</legend>{group.min_selections > 0 && <small className="customer-customization-help">Choose at least {group.min_selections}{group.max_selections > group.min_selections ? `, up to ${group.max_selections}` : ''}.</small>}{group.options.map((option) => {
              const checked = customizeSelection.map(String).includes(String(option.option_id));
              return <button key={option.option_id} type="button" className={`customer-customization-option ${checked ? 'selected' : ''}`} aria-pressed={checked} disabled={option.available === false} onClick={() => toggleCustomization(group, option)}><span>{option.name}{option.available === false ? ' · Sold out' : ''}</span><strong>{Number(option.price_delta) > 0 ? `+${currency.format(Number(option.price_delta))}` : Number(option.price_delta) < 0 ? `−${currency.format(Math.abs(Number(option.price_delta)))}` : 'Included'}</strong></button>;
            })}</fieldset>)}
            <div className="customer-customization-price"><span>Price before adding</span><strong>{currency.format(customizationUnitPrice(customizeItem, customizeSelection))}</strong></div>
            <button className="button button-primary" onClick={() => addToCart(customizeItem, customizeSelection)} disabled={!customizationSelectionValid(customizeItem, customizeSelection)}><Plus size={16} /> Add to Your Order</button>
          </div>
        </Modal>
      )}

      {showCustomerForm && (
        <Modal title="Add a customer" onClose={() => setShowCustomerForm(false)}>
          <form className="modal-form" onSubmit={createCustomer}>
            <p className="muted">Save their details for a warmer welcome next time.</p>
            <label>
              Full name
              <input
                value={customerDraft.FullName}
                onChange={(event) => setCustomerDraft({ ...customerDraft, FullName: event.target.value })}
                required
                autoFocus
              />
            </label>
            <label>
              Phone <span className="optional-text">optional</span>
              <input
                type="tel"
                value={customerDraft.Phone}
                onChange={(event) => setCustomerDraft({ ...customerDraft, Phone: event.target.value })}
              />
            </label>
            <label>
              Email <span className="optional-text">optional</span>
              <input
                type="email"
                value={customerDraft.Email}
                onChange={(event) => setCustomerDraft({ ...customerDraft, Email: event.target.value })}
              />
            </label>
            <label>
              Address <span className="optional-text">optional</span>
              <textarea
                rows="2"
                value={customerDraft.Address}
                onChange={(event) => setCustomerDraft({ ...customerDraft, Address: event.target.value })}
              />
            </label>
            {customerError && <p className="form-error" role="alert">{customerError}</p>}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={() => setShowCustomerForm(false)}>Cancel</button>
              <button className="button button-primary" disabled={customerSaving}>
                {customerSaving ? 'Saving…' : 'Save customer'} <ArrowRight size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showCheckout && (
        <Modal
          title={checkoutRequest ? 'Resume sale' : 'Take payment'}
          onClose={() => !checkoutBusy && setShowCheckout(false)}
        >
          <form className="modal-form checkout-form" onSubmit={completeCheckout}>
            <div className="checkout-total-card">
              <span>AMOUNT DUE</span>
              <strong>{currency.format(checkoutRequest?.amountDue ?? saleQuote?.total ?? total)}</strong>
              {selectedCustomer && <small>For {selectedCustomer.FullName}</small>}
            </div>
            <label>
              Cash received
              <div className="money-input">
                <span>₱</span>
                <input
                  type="number"
                  min={checkoutRequest?.amountDue ?? saleQuote?.total ?? total}
                  step="0.01"
                  value={cashTendered}
                  onChange={(event) => setCashTendered(event.target.value)}
                  disabled={Boolean(checkoutRequest)}
                  required
                />
              </div>
              <small className="change-preview">
                <ArrowDownLeft size={13} /> Change: {currency.format(Math.max(0, Number(cashTendered || 0) - (checkoutRequest?.amountDue ?? saleQuote?.total ?? total)))}
              </small>
            </label>
            <div className="checkout-footnote">
              <Check size={15} /> Cashier: {cashierName}
            </div>
            {checkoutError && <p className="form-error" role="alert">{checkoutError}</p>}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={() => setShowCheckout(false)} disabled={checkoutBusy}>Back</button>
              <button className="button button-primary" disabled={checkoutBusy}>
                {checkoutBusy ? 'Processing…' : checkoutRequest ? 'Retry same sale' : 'Complete sale'}
                {!checkoutBusy && <Check size={17} />}
              </button>
            </div>
            {checkoutRequest && (
              <p className="resume-note">This retries the saved sale request with the same idempotency key.</p>
            )}
          </form>
        </Modal>
      )}
      {saleResult && (
        <div className="customer-drawer-backdrop sale-result-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSaleResult(null)}>
          <section className="customer-success-card sale-result-card" role="dialog" aria-modal="true" aria-label="Payment confirmation">
            <span className="customer-success-icon"><CheckCircle2 size={27} /></span>
            <span className="customer-eyebrow">PAYMENT CONFIRMED</span>
            <h2>Ticket #{saleResult.orderNumber}</h2>
            <p>Paid {currency.format(saleResult.total)} · Change {currency.format(saleResult.changeGiven)}</p>
            <PrintDocument order={saleResult} kind="ticket" />
            <PrintDocument order={saleResult} kind="receipt" />
            <button className="customer-secondary-button" onClick={() => printDocument('ticket')}>Print Ticket <ReceiptText size={16} /></button>
            <button className="customer-primary-button" onClick={() => printDocument('receipt')}>Print Receipt <ReceiptText size={16} /></button>
            <button className="customer-text-button" onClick={() => setSaleResult(null)}>Done</button>
          </section>
        </div>
      )}
    </main>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default App;
