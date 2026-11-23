
# FixMate — Device & Home Appliance Repair Platform

FixMate is a web-based repair service platform that connects customers with technicians who provide repair services for smartphones, laptops and PCs, air conditioners, refrigerators, televisions, washing machines, and other electrical devices.

Customers can explore available repair services, submit repair requests, follow their booking progress, and pay after a repair has been completed. Technicians can publish and manage their services and handle incoming repair requests. Administrators oversee users, service approvals, bookings, and transactions.

## Project Links

- **Live application:** https://fixmate-client-murex.vercel.app
- **Frontend repository:** https://github.com/md-tanjim/FixMate-client
- **Backend repository:** https://github.com/md-tanjim/FixMate-server

## Project Overview

FixMate follows a pay-after-service workflow. A customer chooses an available service and submits a repair request. The assigned technician handles the job and, when the repair is complete, specifies the final amount. The customer can then complete the payment through Stripe Checkout.

The application has three account roles: **Customer**, **Technician**, and **Admin**. Each role has its own dashboard and available actions.

## Key Features

### Customer

- Browse available repair services and view service and technician details.
- Search services and filter by category and service mode; sort by price or newest listing.
- Submit a repair request with contact details, address, preferred date, and a description of the problem.
- View booking details and track the booking status.
- Cancel a booking while it is still in the requested state.
- Pay for a completed repair through Stripe Checkout.
- Review payment history, copy transaction IDs, and download PDF payment receipts.
- Update profile information.

### Technician

- Create repair service listings with descriptions, categories, pricing, estimated duration, service mode, service area, and an image.
- View and manage personal service listings, including editing, deleting, and changing availability.
- Review incoming customer repair requests.
- Accept or reject requests, start accepted jobs, and mark repairs as completed with a final amount.
- View service and request information from the technician dashboard.

### Admin

- View platform statistics, booking activity, and revenue analytics.
- Manage users and update account roles.
- Review submitted service listings and approve or reject them.
- Monitor all bookings and payment transactions.

### Repair and Payment Workflow

1. A customer browses an approved, available service and opens its details page.
2. The customer submits a repair request.
3. The technician accepts or rejects the request. An accepted job can move to in progress.
4. When the repair is finished, the technician marks the job completed and provides the final amount.
5. The customer pays the final amount using Stripe Checkout.
6. The payment success page asks the backend to verify the Checkout Session and displays the confirmed payment details.

Booking states used by the application include `requested`, `accepted`, `in-progress`, `completed`, `rejected`, and `cancelled`. Payment states include `unpaid` and `paid`.

## Technology Stack

| Area | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI library | React 19 |
| Language | TypeScript |
| Styling | Tailwind CSS 4, shadcn/ui, Base UI |
| Authentication | Better Auth with MongoDB adapter, admin and JWT plugins |
| Database connectivity | MongoDB Node.js driver (used by the Better Auth configuration) |
| Backend communication | Fetch API with the Express backend |
| Payments | Stripe Checkout integration |
| Image hosting | ImgBB through a Next.js upload route |
| Charts | Recharts |
| PDF receipts | jsPDF |
| Notifications | React Toastify |
| Icons | Lucide React and React Icons |
| Theme support | next-themes |

### Installed Packages

The following direct dependencies are declared in `package.json`.

**Application dependencies:**

- `next`, `react`, `react-dom`
- `better-auth`, `@better-auth/mongo-adapter`, `mongodb`
- `@stripe/stripe-js`, `stripe`
- `tw-animate-css`
- `shadcn`, `@base-ui/react`, `class-variance-authority`, `cn`
- `lucide-react`, `react-icons`, `next-themes`
- `recharts`, `jspdf`, `react-toastify`

**Development and formatting tools:**

- `typescript`, `tailwindcss`, `@tailwindcss/postcss`
- `eslint`, `eslint-config-next`
- `prettier`, `prettier-plugin-tailwindcss`
- `@types/node`, `@types/react`, `@types/react-dom`
